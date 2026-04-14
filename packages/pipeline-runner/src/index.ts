// Pipeline runner — barrel export (populated as modules are added)
export { validateStageData } from './validate.js';
export type { ValidationResult } from './validate.js';
export { PIPELINE_EVENTS, STAGE_EVENTS, PROVIDER_EVENTS } from './events.js';
export type {
  PipelineStartedPayload,
  PipelineCompletePayload,
  PipelineFailedPayload,
  PipelineHaltedPayload,
  StageStartedPayload,
  StageCompletePayload,
  StageSkippedPayload,
  StageDegradedPayload,
  ProviderSelectedPayload,
  ProviderFailedPayload,
  FanoutStartedPayload,
  FanoutCompletePayload,
} from './events.js';
export type {
  PipelineSpec,
  StageSpec,
  TerminationPolicy,
  StopConditionRef,
  ReducerRef,
  ErrorPolicy,
  SchemaRef,
  PipelineContext,
} from './spec.js';
