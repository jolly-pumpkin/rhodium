// ── Pipeline lifecycle events ────────────────────────────────────
export const PIPELINE_EVENTS = {
  STARTED: 'pipeline:started',
  COMPLETE: 'pipeline:complete',
  FAILED: 'pipeline:failed',
  HALTED_ITERATION_LIMIT: 'pipeline:halted-iteration-limit',
} as const;

// ── Stage lifecycle events ───────────────────────────────────────
export const STAGE_EVENTS = {
  STARTED: 'stage:started',
  COMPLETE: 'stage:complete',
  SKIPPED: 'stage:skipped',
  DEGRADED: 'stage:degraded',
} as const;

// ── Provider events ──────────────────────────────────────────────
export const PROVIDER_EVENTS = {
  SELECTED: 'provider:selected',
  FAILED: 'provider:failed',
  FANOUT_STARTED: 'providers:fanout-started',
  FANOUT_COMPLETE: 'providers:fanout-complete',
} as const;

// ── Payload types ────────────────────────────────────────────────
export interface PipelineStartedPayload {
  runId: string;
  specName: string;
  /** The iteration number about to begin (1-indexed). */
  iteration: number;
}

export interface PipelineCompletePayload {
  runId: string;
  specName: string;
  durationMs: number;
  stageCount: number;
}

export interface PipelineFailedPayload {
  runId: string;
  specName: string;
  failedStageId: string;
  error: string;
}

export interface PipelineHaltedPayload {
  runId: string;
  specName: string;
  /** The iteration count reached when the limit was hit. */
  iteration: number;
}

export interface StageStartedPayload {
  runId: string;
  stageId: string;
  capability: string;
  policy: 'single' | 'fanout';
}

export interface StageCompletePayload {
  runId: string;
  stageId: string;
  durationMs: number;
}

/** Stage never ran — provider was missing and errorPolicy was 'skip'. */
export interface StageSkippedPayload {
  runId: string;
  stageId: string;
  reason: string;
}

/** Stage ran partially — some providers failed but errorPolicy was 'fall-through'. */
export interface StageDegradedPayload {
  runId: string;
  stageId: string;
  reason: string;
}

export interface ProviderSelectedPayload {
  runId: string;
  stageId: string;
  providerId: string;
  priority: number;
}

export interface ProviderFailedPayload {
  runId: string;
  stageId: string;
  providerId: string;
  error: string;
}

export interface FanoutStartedPayload {
  runId: string;
  stageId: string;
  providerCount: number;
}

export interface FanoutCompletePayload {
  runId: string;
  stageId: string;
  successCount: number;
  failureCount: number;
}
