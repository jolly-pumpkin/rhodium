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

/**
 * Compose stage input from inputFrom references or fall back to initial input.
 *
 * stageOutputs accumulates across iterations — a skipped stage leaves its
 * previous iteration's value in the map. Downstream stages that reference a
 * skipped stage via inputFrom will receive that stale value (or undefined on
 * the first iteration). This is intentional: callers can detect a skipped
 * upstream by checking for undefined in the composed input.
 */
function composeInput(
  stage: { id: string; inputFrom?: string[] },
  knownStageIds: Set<string>,
  ctx: PipelineContext,
  initialInput: unknown,
): unknown {
  if (!stage.inputFrom || stage.inputFrom.length === 0) return initialInput;
  const composed: Record<string, unknown> = {};
  for (const sourceId of stage.inputFrom) {
    if (!knownStageIds.has(sourceId)) {
      throw new Error(
        `Stage "${stage.id}" references unknown inputFrom stage "${sourceId}"`,
      );
    }
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
    // stageOutputs accumulates across all iterations — see composeInput note above
    stageOutputs: new Map(),
    iteration: 0,
    startedAt: performance.now(),
    stopped: false,
  };

  const knownStageIds = new Set(spec.stages.map((s) => s.id));

  emit(PIPELINE_EVENTS.STARTED, {
    runId: ctx.runId,
    specName: spec.name,
    iteration: 1,
  });

  // Tracks the last-attempted stage so pipeline:failed has accurate context
  let currentStageId = '<pre-loop>';

  try {
    for (let i = 0; i < spec.termination.maxIterations; i++) {
      ctx.iteration = i + 1;

      for (const stage of spec.stages) {
        currentStageId = stage.id;
        const input = composeInput(stage, knownStageIds, ctx, initialInput);

        if (stage.policy === 'fanout') {
          await executeFanoutStage(stage, ctx, input, broker.resolveAll, emit);
        } else {
          await executeSingleStage(stage, ctx, input, broker.resolve, emit);
        }
      }

      // Check stop condition after all stages complete for this iteration
      if (spec.termination.stopCondition) {
        currentStageId = '<stop-condition>';
        const cap = spec.termination.stopCondition.capability;
        const checker = broker.resolve(cap);
        if (typeof checker !== 'function') {
          throw new Error(
            `Stop condition "${cap}" did not resolve to a function`,
          );
        }
        if ((checker as (ctx: { iteration: number; stageOutputs: Map<string, unknown> }) => boolean)(
          { iteration: ctx.iteration, stageOutputs: ctx.stageOutputs },
        )) {
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
      failedStageId: currentStageId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
