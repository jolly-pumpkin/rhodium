import type {
  ContextContribution,
  TokenBudgetConfig,
  DroppedContribution,
  BudgetOverflowPayload,
} from '../../core/src/types.js';
import { ContributionTooLargeError } from '../../core/src/errors.js';
import type { AllocationResult, TokenCounter } from './types.js';
import { createTokenCounter } from './counter.js';

const DEFAULT_MAX_CONTRIBUTION_BYTES = 262_144; // 256KB

export interface AllocatorOptions {
  emit?: (event: 'budget:overflow', payload: BudgetOverflowPayload) => void;
  tokenCounter?: TokenCounter;
  maxContributionBytes?: number;
}

// Shared text extraction — used by BOTH byte check and token estimation
function contributionText(c: ContextContribution): string {
  return (c.systemPromptFragment ?? '') +
    (c.tools && c.tools.length > 0 ? JSON.stringify(c.tools) : '');
}

function computeSeverity(priority: number): 'info' | 'warning' | 'critical' {
  if (priority > 80) return 'critical';
  if (priority > 50) return 'warning';
  return 'info';
}

function estimateTokens(c: ContextContribution, counter: TokenCounter): number {
  return counter(contributionText(c));
}

export function allocateBudget(
  contributions: ContextContribution[],
  config: TokenBudgetConfig,
  opts: AllocatorOptions = {}
): AllocationResult {
  const {
    emit,
    tokenCounter = createTokenCounter(),
    maxContributionBytes = DEFAULT_MAX_CONTRIBUTION_BYTES,
  } = opts;

  // Pre-check: enforce per-contribution byte limit using the same text as token estimation
  for (const c of contributions) {
    const text = contributionText(c);
    const bytes = new TextEncoder().encode(text).length;
    if (bytes > maxContributionBytes) {
      throw new ContributionTooLargeError(c.pluginKey, bytes, maxContributionBytes);
    }
  }

  const availableTokens =
    config.maxTokens -
    (config.reservedSystemTokens ?? 0) -
    (config.reservedToolTokens ?? 0);

  const strategy = config.allocationStrategy ?? 'priority';

  if (strategy === 'proportional') {
    return allocateProportional(contributions, availableTokens, tokenCounter, emit);
  }
  if (strategy === 'equal') {
    return allocateEqual(contributions, availableTokens, tokenCounter, emit);
  }
  return allocatePriority(contributions, availableTokens, tokenCounter, emit);
}

type EmitFn = AllocatorOptions['emit'];

function allocatePriority(
  contributions: ContextContribution[],
  availableTokens: number,
  counter: TokenCounter,
  emit: EmitFn
): AllocationResult {
  const sorted = [...contributions].sort((a, b) => b.priority - a.priority);
  const allocated: AllocationResult['allocated'] = [];
  const dropped: DroppedContribution[] = [];
  let remaining = availableTokens;

  for (const c of sorted) {
    const estimated = estimateTokens(c, counter);
    const severity = computeSeverity(c.priority);

    // atomic takes precedence over minTokens when content won't fit
    if (c.atomic && estimated > remaining) {
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'atomic', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'atomic' });
      continue;
    }

    // minTokens check (after atomic, so atomic contributions with minTokens are caught above)
    if (c.minTokens !== undefined && remaining < c.minTokens) {
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'minTokens', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'minTokens' });
      continue;
    }

    if (remaining === 0) {
      // No budget left — drop with budget reason
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'budget', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'overflow' });
    } else if (estimated <= remaining) {
      // Fits fully
      allocated.push({ pluginKey: c.pluginKey, tokens: estimated, truncated: false });
      remaining -= estimated;
    } else {
      // Non-atomic truncation: give what's left
      allocated.push({ pluginKey: c.pluginKey, tokens: remaining, truncated: true });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated - remaining, reason: 'overflow' });
      remaining = 0;
    }
  }

  const totalAllocated = allocated.reduce((sum, a) => sum + a.tokens, 0);
  return { allocated, dropped, totalAllocated };
}

function allocateProportional(
  contributions: ContextContribution[],
  availableTokens: number,
  counter: TokenCounter,
  emit: EmitFn
): AllocationResult {
  const totalPriority = contributions.reduce((sum, c) => sum + c.priority, 0);
  const allocated: AllocationResult['allocated'] = [];
  const dropped: DroppedContribution[] = [];

  for (const c of contributions) {
    const estimated = estimateTokens(c, counter);
    const severity = computeSeverity(c.priority);
    const share = totalPriority > 0
      ? Math.floor((c.priority / totalPriority) * availableTokens)
      : Math.floor(availableTokens / contributions.length);

    // atomic before minTokens
    if (c.atomic && estimated > share) {
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'atomic', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'atomic' });
      continue;
    }

    if (c.minTokens !== undefined && share < c.minTokens) {
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'minTokens', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'minTokens' });
      continue;
    }

    const actualTokens = Math.min(estimated, share);
    const truncated = actualTokens < estimated;
    allocated.push({ pluginKey: c.pluginKey, tokens: actualTokens, truncated });
    if (truncated) {
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated - actualTokens, reason: 'overflow' });
    }
  }

  const totalAllocated = allocated.reduce((sum, a) => sum + a.tokens, 0);
  return { allocated, dropped, totalAllocated };
}

function allocateEqual(
  contributions: ContextContribution[],
  availableTokens: number,
  counter: TokenCounter,
  emit: EmitFn
): AllocationResult {
  if (contributions.length === 0) {
    return { allocated: [], dropped: [], totalAllocated: 0 };
  }

  const share = Math.floor(availableTokens / contributions.length);
  const allocated: AllocationResult['allocated'] = [];
  const dropped: DroppedContribution[] = [];

  for (const c of contributions) {
    const estimated = estimateTokens(c, counter);
    const severity = computeSeverity(c.priority);

    // atomic before minTokens
    if (c.atomic && estimated > share) {
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'atomic', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'atomic' });
      continue;
    }

    if (c.minTokens !== undefined && share < c.minTokens) {
      dropped.push({ pluginKey: c.pluginKey, priority: c.priority, reason: 'minTokens', estimatedTokens: estimated, severity });
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated, reason: 'minTokens' });
      continue;
    }

    const actualTokens = Math.min(estimated, share);
    const truncated = actualTokens < estimated;
    allocated.push({ pluginKey: c.pluginKey, tokens: actualTokens, truncated });
    if (truncated) {
      emit?.('budget:overflow', { pluginKey: c.pluginKey, priority: c.priority, severity, droppedTokens: estimated - actualTokens, reason: 'overflow' });
    }
  }

  const totalAllocated = allocated.reduce((sum, a) => sum + a.tokens, 0);
  return { allocated, dropped, totalAllocated };
}
