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

// Strategy stubs — implement in subsequent tasks
function allocatePriority(
  _contributions: ContextContribution[],
  _availableTokens: number,
  _counter: TokenCounter,
  _emit: EmitFn
): AllocationResult {
  return { allocated: [], dropped: [], totalAllocated: 0 };
}

function allocateProportional(
  _contributions: ContextContribution[],
  _availableTokens: number,
  _counter: TokenCounter,
  _emit: EmitFn
): AllocationResult {
  return { allocated: [], dropped: [], totalAllocated: 0 };
}

function allocateEqual(
  _contributions: ContextContribution[],
  _availableTokens: number,
  _counter: TokenCounter,
  _emit: EmitFn
): AllocationResult {
  return { allocated: [], dropped: [], totalAllocated: 0 };
}
