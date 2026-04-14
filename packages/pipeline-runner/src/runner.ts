import type { PipelineSpec, PipelineContext } from './spec.js';
import { executeSingleStage, executeFanoutStage } from './stage.js';
import type { ProviderHandle } from './stage.js';
import { PIPELINE_EVENTS } from './events.js';

export interface BrokerFacade {
  resolve: (capability: string) => unknown;
  resolveAll: (capability: string) => ProviderHandle[];
}

type EmitFn = (event: string, payload: unknown) => void;

let runCounter = 0;

function generateRunId(): string {
  return `run-${++runCounter}-${Date.now()}`;
}

/** Compose stage input from inputFrom references or fall back to initial input. */
function composeInput(
  stage: { inputFrom?: string[] },
  ctx: PipelineContext,
  initialInput: unknown,
): unknown {
  if (!stage.inputFrom || stage.inputFrom.length === 0) return initialInput;
  const composed: Record<string, unknown> = {};
  for (const sourceId of stage.inputFrom) {
    composed[sourceId] = ctx.stageOutputs.get(sourceId);
  }
  return composed;
}

export interface PipelineResult {
  runId: string;
  specName: string;
  stageOutputs: Map<string, unknown>;
  iteration: number;
  durationMs: number;
  stopped: boolean;
}

export async function runPipeline(
  spec: PipelineSpec,
  initialInput: unknown,
  broker: BrokerFacade,
  emit: EmitFn,
): Promise<PipelineResult> {
  const ctx: PipelineContext = {
    specName: spec.name,
    runId: generateRunId(),
    stageOutputs: new Map(),
    iteration: 0,
    startedAt: performance.now(),
    stopped: false,
  };

  emit(PIPELINE_EVENTS.STARTED, {
    runId: ctx.runId,
    specName: spec.name,
    iteration: 1,
  });

  try {
    for (let i = 0; i < spec.termination.maxIterations; i++) {
      ctx.iteration = i + 1;

      for (const stage of spec.stages) {
        const input = composeInput(stage, ctx, initialInput);

        if (stage.policy === 'fanout') {
          await executeFanoutStage(stage, ctx, input, broker.resolveAll, emit);
        } else {
          await executeSingleStage(stage, ctx, input, broker.resolve, emit);
        }
      }

      // Check stop condition
      if (spec.termination.stopCondition) {
        const checker = broker.resolve(spec.termination.stopCondition.capability) as
          (ctx: { iteration: number; stageOutputs: Map<string, unknown> }) => boolean;
        if (checker({ iteration: ctx.iteration, stageOutputs: ctx.stageOutputs })) {
          ctx.stopped = true;
          break;
        }
      }

      // Emit halted if this was the last allowed iteration
      if (i === spec.termination.maxIterations - 1 && !ctx.stopped) {
        emit(PIPELINE_EVENTS.HALTED_ITERATION_LIMIT, {
          runId: ctx.runId,
          specName: spec.name,
          iteration: ctx.iteration,
        });
      }
    }

    const durationMs = Math.round(performance.now() - ctx.startedAt);

    emit(PIPELINE_EVENTS.COMPLETE, {
      runId: ctx.runId,
      specName: spec.name,
      durationMs,
      stageCount: spec.stages.length,
    });

    return {
      runId: ctx.runId,
      specName: spec.name,
      stageOutputs: ctx.stageOutputs,
      iteration: ctx.iteration,
      durationMs,
      stopped: ctx.stopped,
    };
  } catch (err) {
    emit(PIPELINE_EVENTS.FAILED, {
      runId: ctx.runId,
      specName: spec.name,
      failedStageId: 'unknown',
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
