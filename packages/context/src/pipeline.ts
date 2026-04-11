import type {
  Plugin,
  ContextRequest,
  ContextContribution,
  AssembledContext,
  AssembledTool,
  DroppedContribution,
  TokenBudgetConfig,
  RemainingBudget,
  ToolDeclaration,
  ToolExample,
  BrokerEvent,
  BrokerEventPayload,
} from '../../core/src/types.js';
import { ContributionTooLargeError } from '../../core/src/errors.js';
import { allocateBudget } from '../../budget/src/allocator.js';
import type { TokenCounter } from '../../budget/src/types.js';
import { createTokenCounter } from '../../budget/src/counter.js';
import { searchTools } from '../../discovery/src/search.js';
import type { SearchIndex } from '../../discovery/src/index-builder.js';
import type { MiddlewarePlugin } from './types.js';

type EmitFn = <E extends BrokerEvent>(event: E, payload: BrokerEventPayload[E]) => void;

const DEFAULT_MAX_CONTRIBUTION_BYTES = 262_144; // 256KB

export interface PipelineOptions {
  /** Returns the current list of active plugins to include in assembly. */
  getActivePlugins: () => Plugin[];
  /** Event bus for emitting context:assembled and plugin:error events. */
  eventBus: { emit: EmitFn };
  /** Optional tool search index (from rhodium-discovery). Required for Stage 4 Discover. */
  searchIndex?: SearchIndex;
  /**
   * Returns middleware plugins in priority order.
   * Sorting by priority is the caller's responsibility — MiddlewarePlugin has no priority field.
   * The broker should sort by the plugin's CapabilityDeclaration.priority before passing.
   */
  getMiddlewares: () => MiddlewarePlugin[];
  /**
   * Token counter function. Defaults to chars4 (~90% accurate, zero deps) per ADR-004.
   * Override with createTokenCounter('tiktoken') for exact counting.
   */
  tokenCounter?: TokenCounter;
  /** Name of the token counter strategy, for AssemblyMeta.tokenCounter. Defaults to 'chars4'. */
  tokenCounterName?: string;
  /** Max bytes per contribution before rejection in Stage 1. Defaults to 256KB. */
  maxContributionBytes?: number;
  /** Default token budget. Can be overridden per-call via ContextRequest.tokenBudget. */
  defaultTokenBudget?: TokenBudgetConfig;
}

export function createPipeline(opts: PipelineOptions): {
  assembleContext<TState = unknown>(request?: ContextRequest<TState>): AssembledContext;
} {
  // ADR-004: chars4 is the project default (~90% accurate, zero deps)
  const counter = opts.tokenCounter ?? createTokenCounter('chars4');
  const counterName = opts.tokenCounterName ?? 'chars4';
  const maxBytes = opts.maxContributionBytes ?? DEFAULT_MAX_CONTRIBUTION_BYTES;

  return { assembleContext };

  function assembleContext<TState = unknown>(request?: ContextRequest<TState>): AssembledContext {
    const startTime = performance.now();

    // ── Effective budget ────────────────────────────────────────────────────
    const budget: TokenBudgetConfig = request?.tokenBudget ?? opts.defaultTokenBudget ?? { maxTokens: 0 };

    // ── STAGE 1: Collect ────────────────────────────────────────────────────
    const allPlugins = opts.getActivePlugins();
    const totalPlugins = allPlugins.length;

    // Apply includePlugins / excludePlugins filters
    const filtered = filterPlugins(allPlugins, request?.includePlugins, request?.excludePlugins);

    // RemainingBudget is a static snapshot — usedTokens is always 0 at collection time.
    // Actual allocation happens in Stage 3 (Budget). Plugins using usedTokens/remainingTokens
    // to self-size contributions will see the pre-reserved total, not a live-draining view.
    const remainingBudget: RemainingBudget = {
      totalTokens: budget.maxTokens,
      usedTokens: 0,
      remainingTokens: budget.maxTokens - (budget.reservedSystemTokens ?? 0) - (budget.reservedToolTokens ?? 0),
      allocationStrategy: budget.allocationStrategy ?? 'priority',
    };

    const contributions: ContextContribution[] = [];
    const errorDropped: DroppedContribution[] = [];

    for (const plugin of filtered) {
      if (!plugin.contributeContext) continue;

      let contribution: ContextContribution | null | undefined;
      try {
        contribution = plugin.contributeContext(request ?? {}, remainingBudget);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        errorDropped.push({
          pluginKey: plugin.key,
          priority: 0,
          reason: 'error',
          estimatedTokens: 0,
          severity: 'warning',
        });
        opts.eventBus.emit('plugin:error', {
          pluginKey: plugin.key,
          error,
          severity: 'warning',
        });
        continue;
      }

      // null/undefined = plugin opted out — not a drop, not a contribution
      if (contribution == null) continue;

      // Merge tools: manifest baseline → runtime override/additions → example dedup
      const mergedTools = mergeTools(plugin.manifest.tools, contribution.tools ?? []);
      contribution = { ...contribution, tools: mergedTools };

      // Enforce maxContributionBytes per ARD §10: reject oversized contributions
      // before they enter the budget pipeline (Stage 1, not Stage 3).
      // Uses 'contribution-too-large' to distinguish from token-budget drops ('budget-exceeded').
      const text = contributionText(contribution);
      const bytes = new TextEncoder().encode(text).length;
      if (bytes > maxBytes) {
        const severity = contribution.priority > 80 ? 'critical' : contribution.priority > 50 ? 'warning' : 'info';
        errorDropped.push({
          pluginKey: contribution.pluginKey,
          priority: contribution.priority,
          reason: 'contribution-too-large',
          estimatedTokens: counter(text),
          severity,
        });
        continue;
      }

      contributions.push(contribution);
    }

    // ── STAGE 2: Prioritize ─────────────────────────────────────────────────
    contributions.sort((a, b) => b.priority - a.priority);

    // ── STAGE 3: Budget ─────────────────────────────────────────────────────
    let allocated: Array<{ pluginKey: string; tokens: number; truncated: boolean }> = [];
    let budgetDropped: DroppedContribution[] = [];

    // Byte limit is already enforced in Stage 1. ContributionTooLargeError from the
    // allocator should not occur under normal operation, but we handle it defensively
    // as a safety fallback in case the allocator's default limit differs.
    let remaining = [...contributions];
    while (remaining.length > 0) {
      try {
        const result = allocateBudget(remaining, budget, {
          emit: opts.eventBus.emit,
          tokenCounter: counter,
          maxContributionBytes: maxBytes,
        });
        allocated = result.allocated;
        budgetDropped = result.dropped;
        break;
      } catch (err) {
        if (err instanceof ContributionTooLargeError) {
          const bad = remaining.find(c => c.pluginKey === err.pluginKey);
          if (bad) {
            const text = contributionText(bad);
            const severity = bad.priority > 80 ? 'critical' : bad.priority > 50 ? 'warning' : 'info';
            budgetDropped.push({
              pluginKey: bad.pluginKey,
              priority: bad.priority,
              reason: 'budget-exceeded',
              estimatedTokens: counter(text),
              severity,
            });
            remaining = remaining.filter(c => c.pluginKey !== err.pluginKey);
          } else {
            break; // shouldn't happen
          }
        } else {
          throw err;
        }
      }
    }

    const survivingKeys = new Set(allocated.map(a => a.pluginKey));
    const allDropped: DroppedContribution[] = [...errorDropped, ...budgetDropped];

    // ── STAGE 4: Discover ───────────────────────────────────────────────────
    // Build the assembled tools from budget-surviving contributions
    let assembledTools: AssembledTool[] = [];
    for (const c of contributions) {
      if (!survivingKeys.has(c.pluginKey)) continue;
      for (const tool of c.tools ?? []) {
        assembledTools.push({ ...tool, pluginKey: c.pluginKey });
      }
    }

    if (request?.query && opts.searchIndex) {
      // Run full tool search (unscoped), then filter post-hoc to budget-surviving plugins.
      // This avoids repurposing activatedPlugins (which has lifecycle semantics) for
      // budget-survival semantics.
      const results = searchTools(opts.searchIndex, { query: request.query });

      // Keep only results from plugins that survived the budget stage
      const survivingResults = results.filter(r => survivingKeys.has(r.pluginKey));
      const matchSet = new Set(survivingResults.map(r => `${r.pluginKey}:${r.toolName}`));
      const relevanceMap = new Map(survivingResults.map(r => [`${r.pluginKey}:${r.toolName}`, r.relevanceScore]));

      assembledTools = assembledTools
        .filter(t => matchSet.has(`${t.pluginKey}:${t.name}`))
        .map(t => ({ ...t, relevanceScore: relevanceMap.get(`${t.pluginKey}:${t.name}`) }));
    }

    // ── STAGE 5: Middleware ─────────────────────────────────────────────────
    // Build context before middleware — middleware may transform any field
    const preMiddlewareContext: AssembledContext = {
      systemPrompt: buildSystemPrompt(contributions, survivingKeys),
      tools: assembledTools,
      totalTokens: 0, // recalculated in Stage 6
      dropped: allDropped,
      meta: {
        totalPlugins,
        contributingPlugins: allocated.length,
        droppedPlugins: allDropped.length,
        allocationStrategy: budget.allocationStrategy ?? 'priority',
        durationMs: 0, // filled at end
        tokenCounter: counterName,
      },
    };

    let ctx = preMiddlewareContext;
    for (const mw of opts.getMiddlewares()) {
      ctx = mw.postAssembly?.(ctx) ?? ctx;
    }

    // ── STAGE 6: Serialize ──────────────────────────────────────────────────
    // Skip empty tools JSON to avoid counting '[]' (2 chars) as tokens
    const toolsJson = ctx.tools.length > 0 ? JSON.stringify(ctx.tools) : '';
    const totalTokens = counter(ctx.systemPrompt + toolsJson);
    const durationMs = performance.now() - startTime;

    const assembled: AssembledContext = {
      ...ctx,
      totalTokens,
      meta: { ...ctx.meta, durationMs },
    };

    opts.eventBus.emit('context:assembled', {
      totalTokens,
      droppedCount: allDropped.length,
      durationMs,
    });

    return assembled;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replicates allocator's text extraction for byte-limit pre-check in Stage 1. */
function contributionText(c: ContextContribution): string {
  return (c.systemPromptFragment ?? '') +
    (c.tools && c.tools.length > 0 ? JSON.stringify(c.tools) : '');
}

function filterPlugins(
  plugins: Plugin[],
  includePlugins?: string[],
  excludePlugins?: string[],
): Plugin[] {
  let result = plugins;
  if (includePlugins?.length) {
    const include = new Set(includePlugins);
    result = result.filter(p => include.has(p.key));
  }
  if (excludePlugins?.length) {
    const exclude = new Set(excludePlugins);
    result = result.filter(p => !exclude.has(p.key));
  }
  return result;
}

function mergeTools(
  manifestTools: ToolDeclaration[],
  runtimeTools: ToolDeclaration[],
): ToolDeclaration[] {
  // Start with manifest baseline
  const merged = new Map<string, ToolDeclaration>(manifestTools.map(t => [t.name, { ...t }]));

  for (const rt of runtimeTools) {
    const existing = merged.get(rt.name);
    if (existing) {
      // Override: runtime replaces manifest entirely, then merge examples
      merged.set(rt.name, {
        ...rt,
        examples: mergeExamples(existing.examples ?? [], rt.examples ?? []),
      });
    } else {
      // Addition: new tool name
      merged.set(rt.name, rt);
    }
  }

  return Array.from(merged.values());
}

function mergeExamples(manifest: ToolExample[], runtime: ToolExample[]): ToolExample[] {
  // Runtime examples win on duplicate scenario (override, not just dedup)
  const byScenario = new Map<string, ToolExample>(manifest.map(e => [e.scenario, e]));
  for (const e of runtime) {
    byScenario.set(e.scenario, e); // runtime overrides manifest
  }
  return Array.from(byScenario.values());
}

function buildSystemPrompt(
  contributions: ContextContribution[],
  survivingKeys: Set<string>,
): string {
  return contributions
    .filter(c => survivingKeys.has(c.pluginKey) && c.systemPromptFragment != null)
    .map(c => c.systemPromptFragment!)
    .join('\n\n');
}
