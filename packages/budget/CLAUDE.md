# Rhodium Budget

Token budget allocation and management for context assembly. Ensures finite context stays within limits while respecting plugin priorities.

## Key Modules

- `allocator.ts` — Allocation strategies (priority, proportional, equal)
- `counter.ts` — Token counting (chars/4 default, tiktoken optional)

## Performance Target

`assembleContext()` pipeline must complete in <5ms with 20 plugins.

## Patterns

**Allocation strategies:**
- `priority`: Highest-priority plugins get tokens first, remainder distributed equally
- `proportional`: Tokens allocated by priority weight
- `equal`: Each plugin gets same allocation

**Token counting:** Default chars/4 (~90% accurate) is synchronous. Exact counting via tiktoken requires async—use only if performance target relaxed.

**Fairness:** Document why one allocation strategy chosen over others. Preference order: priority > proportional > equal (simpler reasoning).

## Tests

- Unit: allocator produces correct distributions for each strategy
- Integration: context assembly completes <5ms with 20 plugins
- Edge cases: zero plugins, zero budget, one plugin, max plugins

## Interdependencies

- Depends on: core (PluginContext)
- Depended on by: context (pipeline uses allocator)
