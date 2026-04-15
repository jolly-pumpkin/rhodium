/** Reference to a runtime schema for stage-boundary validation. */
export interface SchemaRef {
  /** Validate a value. Return an array of error strings; empty = valid. */
  validate(value: unknown): string[];
}

/** How a fanout stage reduces multiple provider outputs to one stage output. */
export type ReducerRef =
  | { kind: 'concat' }
  | { kind: 'priority-pick' }
  | { kind: 'custom'; capability: string };

/** Per-stage error handling policy. */
export type ErrorPolicy = 'fail-fast' | 'fall-through' | 'skip';

/** Declaration of a single pipeline stage. */
export interface StageSpec {
  /** Unique within the spec. */
  id: string;
  /** Capability name resolved via the broker. */
  capability: string;
  /** Single provider or parallel fanout over all providers. */
  policy: 'single' | 'fanout';
  /** Required when policy === 'fanout'. Reduces multiple outputs to one. */
  reducer?: ReducerRef;
  /** Prior stage ids whose outputs feed this stage's input. */
  inputFrom?: string[];
  /** How to handle errors for this stage. */
  errorPolicy: ErrorPolicy;
  /** Validated against stage input before execution. */
  inputSchema?: SchemaRef;
  /** Validated against stage output after execution. */
  outputSchema?: SchemaRef;
}

/** Reference to a stop-condition plugin resolved via the broker. */
export interface StopConditionRef {
  capability: string;
}

/** When the pipeline should stop. */
export interface TerminationPolicy {
  /** Hard ceiling — always required. No "run forever" mode. */
  maxIterations: number;
  /** Optional plugin that inspects context and returns true to halt. */
  stopCondition?: StopConditionRef;
}

/** A declarative, serializable pipeline definition consumed by the runner. */
export interface PipelineSpec {
  name: string;
  stages: StageSpec[];
  termination: TerminationPolicy;
}

/**
 * Mutable execution context threaded through a pipeline run.
 * @internal Do not hold references across runs; the runner mutates this object in-place.
 */
export interface PipelineContext {
  specName: string;
  runId: string;
  stageOutputs: Map<string, unknown>;
  iteration: number;
  startedAt: number;
  stopped: boolean;
}
