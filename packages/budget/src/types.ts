import type {
  TokenBudgetConfig,
  ContextContribution,
  RemainingBudget,
  DroppedContribution,
} from 'rhodium-core';

export type { TokenBudgetConfig, ContextContribution, RemainingBudget, DroppedContribution };

export type TokenCounterStrategy =
  | 'chars3'
  | 'chars4'
  | 'tiktoken'
  | ((text: string) => number);

export interface AllocationResult {
  allocated: Array<{
    pluginKey: string;
    tokens: number;
    truncated: boolean;
  }>;
  dropped: DroppedContribution[];
  totalAllocated: number;
}
