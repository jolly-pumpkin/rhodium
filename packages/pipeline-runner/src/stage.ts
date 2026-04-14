import type { StageSpec, PipelineContext } from './spec.js';
import { validateStageData } from './validate.js';
import { STAGE_EVENTS, PROVIDER_EVENTS } from './events.js';
import { concatReducer, priorityPickReducer } from './reducers.js';
import type { FanoutResult } from './reducers.js';

/** Shared function types for stage executors. */
export type ResolveFn = (capability: string) => unknown;
export type ResolveAllFn = (capability: string) => ProviderHandle[];
export type EmitFn = (event: string, payload: unknown) => void;

/** A provider entry as returned by resolveAll in the runner context. */
export interface ProviderHandle {
  id: string;
  priority: number;
  impl: (input: unknown) => unknown;
}

export async function executeSingleStage(
  stage: StageSpec,
  ctx: PipelineContext,
  input: unknown,
  resolve: ResolveFn,
  emit: EmitFn,
): Promise<void> {
  // stage:started means "we attempted the stage" — fires before skip/fail guards
  const start = performance.now();
  emit(STAGE_EVENTS.STARTED, {
    runId: ctx.runId,
    stageId: stage.id,
    capability: stage.capability,
    policy: 'single',
  });

  // Validate input
  const inputCheck = validateStageData(stage.id, 'input', stage.inputSchema, input);
  if (!inputCheck.ok) {
    throw new Error(
      `Stage "${stage.id}" input validation failed: ${inputCheck.errors.join('; ')}`,
    );
  }

  // Resolve provider — skip applies to resolution failure
  let provider: unknown;
  try {
    provider = resolve(stage.capability);
  } catch (err) {
    if (stage.errorPolicy === 'skip') {
      emit(STAGE_EVENTS.SKIPPED, {
        runId: ctx.runId,
        stageId: stage.id,
        reason: `Provider not found for "${stage.capability}"`,
      });
      return;
    }
    throw err;
  }

  if (typeof provider !== 'function') {
    throw new Error(
      `Stage "${stage.id}": resolved capability "${stage.capability}" is not a function`,
    );
  }

  // In single-provider mode, providerId is the capability name (no plugin identity in ResolveFn)
  emit(PROVIDER_EVENTS.SELECTED, {
    runId: ctx.runId,
    stageId: stage.id,
    providerId: stage.capability,
    priority: 0,
  });

  // Invoke provider — skip also applies to execution failure
  let output: unknown;
  try {
    output = await (provider as (input: unknown) => unknown)(input);
  } catch (err) {
    if (stage.errorPolicy === 'skip') {
      emit(STAGE_EVENTS.SKIPPED, {
        runId: ctx.runId,
        stageId: stage.id,
        reason: `Provider execution failed for "${stage.capability}"`,
      });
      return;
    }
    throw err;
  }

  // Validate output
  const outputCheck = validateStageData(stage.id, 'output', stage.outputSchema, output);
  if (!outputCheck.ok) {
    throw new Error(
      `Stage "${stage.id}" output validation failed: ${outputCheck.errors.join('; ')}`,
    );
  }

  ctx.stageOutputs.set(stage.id, output);

  emit(STAGE_EVENTS.COMPLETE, {
    runId: ctx.runId,
    stageId: stage.id,
    durationMs: Math.round(performance.now() - start),
  });
}

export async function executeFanoutStage(
  stage: StageSpec,
  ctx: PipelineContext,
  input: unknown,
  resolveAll: ResolveAllFn,
  emit: EmitFn,
): Promise<void> {
  const start = performance.now();
  emit(STAGE_EVENTS.STARTED, {
    runId: ctx.runId,
    stageId: stage.id,
    capability: stage.capability,
    policy: 'fanout',
  });

  // Validate input
  const inputCheck = validateStageData(stage.id, 'input', stage.inputSchema, input);
  if (!inputCheck.ok) {
    throw new Error(
      `Stage "${stage.id}" input validation failed: ${inputCheck.errors.join('; ')}`,
    );
  }

  const providers = resolveAll(stage.capability);

  emit(PROVIDER_EVENTS.FANOUT_STARTED, {
    runId: ctx.runId,
    stageId: stage.id,
    providerCount: providers.length,
  });

  // Invoke all providers in parallel with per-provider error boundaries
  const settled = await Promise.allSettled(
    providers.map(async (p) => {
      emit(PROVIDER_EVENTS.SELECTED, {
        runId: ctx.runId,
        stageId: stage.id,
        providerId: p.id,
        priority: p.priority,
      });
      const result = await p.impl(input);
      return { providerId: p.id, priority: p.priority, output: result } satisfies FanoutResult;
    }),
  );

  const successes: FanoutResult[] = [];
  let failureCount = 0;

  for (const result of settled) {
    if (result.status === 'fulfilled') {
      successes.push(result.value);
    } else {
      failureCount++;
      emit(PROVIDER_EVENTS.FAILED, {
        runId: ctx.runId,
        stageId: stage.id,
        providerId: 'unknown',
        error: String(result.reason),
      });
    }
  }

  emit(PROVIDER_EVENTS.FANOUT_COMPLETE, {
    runId: ctx.runId,
    stageId: stage.id,
    successCount: successes.length,
    failureCount,
  });

  // Handle case where all providers failed
  if (successes.length === 0) {
    if (stage.errorPolicy === 'fall-through') {
      ctx.stageOutputs.set(stage.id, null);
      emit(STAGE_EVENTS.DEGRADED, {
        runId: ctx.runId,
        stageId: stage.id,
        reason: `All ${failureCount} providers failed for "${stage.capability}"`,
      });
      return;
    }
    if (stage.errorPolicy === 'skip') {
      emit(STAGE_EVENTS.SKIPPED, {
        runId: ctx.runId,
        stageId: stage.id,
        reason: `All providers failed for "${stage.capability}"`,
      });
      return;
    }
    throw new Error(
      `Stage "${stage.id}": all providers failed for "${stage.capability}"`,
    );
  }

  // Reduce
  let reduced: unknown;
  if (!stage.reducer || stage.reducer.kind === 'concat') {
    reduced = concatReducer(successes);
  } else if (stage.reducer.kind === 'priority-pick') {
    reduced = priorityPickReducer(successes);
  } else {
    throw new Error(
      `Stage "${stage.id}": custom reducers are not yet supported in this version`,
    );
  }

  // Validate output
  const outputCheck = validateStageData(stage.id, 'output', stage.outputSchema, reduced);
  if (!outputCheck.ok) {
    throw new Error(
      `Stage "${stage.id}" output validation failed: ${outputCheck.errors.join('; ')}`,
    );
  }

  ctx.stageOutputs.set(stage.id, reduced);

  emit(STAGE_EVENTS.COMPLETE, {
    runId: ctx.runId,
    stageId: stage.id,
    durationMs: Math.round(performance.now() - start),
  });
}
