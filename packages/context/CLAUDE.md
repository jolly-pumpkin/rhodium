# Rhodium Context

Context assembly pipeline and middleware system. Transforms raw plugin contributions into serialized LLM context.

## Key Modules

- `pipeline.ts` — 6-stage pipeline: Collect → Prioritize → Budget → Discover → Middleware → Serialize
- `middleware.ts` — Pre/post hooks for plugin contributions, with execution order guarantees

## Performance Target

Pipeline must complete in <5ms with 20 plugins (including budget allocation).

## Patterns

**Pipeline stages (order is immutable):**
1. **Collect:** Gather all plugin contributions
2. **Prioritize:** Sort by plugin priority
3. **Budget:** Allocate tokens using budget strategy
4. **Discover:** Search tools, filter by budget
5. **Middleware:** Run pre/post hooks (can add/remove tools, modify descriptions)
6. **Serialize:** Convert to final context object

**Middleware ordering:** Pre-hooks run in registration order; post-hooks run in reverse. Don't rely on relative execution across different plugins.

**Tool merging:** Manifest tools are baseline; `contributeContext()` tools override by name, add new ones, concatenate examples.

## Tests

- Unit: each stage in isolation (mock inputs/outputs)
- Integration: full pipeline <5ms with 20 plugins
- Middleware: pre/post hook ordering is correct
- Tool merge: overrides work, examples concatenate, new tools appear

## Interdependencies

- Depends on: core (broker, plugin context), capabilities (validation), budget (allocator)
- Depended on by: applications using `assembleContext()`
