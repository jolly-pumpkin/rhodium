import type {
  ContextContribution,
  TokenBudgetConfig,
  DroppedContribution,
  BudgetOverflowPayload,
} from 'rhodium-core';
import { ContributionTooLargeError } from 'rhodium-core';
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
  return { allocated: [], dropped: [], totalAllocated: 0 };
}
