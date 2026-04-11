# Rhodium Discovery

Manifest-first tool indexing and search. Achieves 85% token reduction by enabling tool discovery without plugin activation.

## Key Modules

- `index-builder.ts` — Build TF-IDF index from manifests at broker activation time
- `search.ts` — Query index, return ranked results
- `ranking.ts` — TF-IDF weighting (tool name 3x, description 2x, tags 2x, plugin description 1x, plugin tags 1x)

## Performance Target

`broker.searchTools(query)` must complete in <2ms (100 tools).

## Patterns

**Index building:** Happens at `broker.activate()` time, not on every search. Results are deterministic and sorted by score.

**Ranking weights:** Tool name 3x, description 2x, tags 2x. Rationale: tool name is most specific signal. Don't change weights without benchmarking impact on token reduction claim (85%).

**Index updates:** When a new tool is registered after activation, index must be updated incrementally (not rebuilt).

## Tests

- Unit: TF-IDF scoring correct for known documents
- Integration: index built from 20+ plugins, search <2ms
- Ranking: query for common tool names returns expected results first
- Token reduction claim: measure actual context savings vs. baseline (no discovery)

## Interdependencies

- Depends on: core (manifests)
- Depended on by: context (discovery stage of pipeline)
