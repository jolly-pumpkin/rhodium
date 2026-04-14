import type { StageSpec, PipelineContext } from './spec.js';
import { validateStageData } from './validate.js';
import { STAGE_EVENTS, PROVIDER_EVENTS } from './events.js';

type ResolveFn = (capability: string) => unknown;
type EmitFn = (event: string, payload: unknown) => void;

export async function executeSingleStage(
  stage: StageSpec,
  ctx: PipelineContext,
  input: unknown,
  resolve: ResolveFn,
  emit: EmitFn,
): Promise<void> {
  emit(STAGE_EVENTS.STARTED, {
    runId: ctx.runId,
    stageId: stage.id,
    capability: stage.capability,
    policy: 'single',
  });

  const start = performance.now();

  // Validate input
  const inputCheck = validateStageData(stage.id, 'input', stage.inputSchema, input);
  if (!inputCheck.ok) {
    throw new Error(
      `Stage "${stage.id}" input validation failed: ${inputCheck.errors.join('; ')}`,
    );
  }

  // Resolve provider
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

  emit(PROVIDER_EVENTS.SELECTED, {
    runId: ctx.runId,
    stageId: stage.id,
    providerId: stage.capability,
    priority: 0,
  });

  const output = await (provider as (input: unknown) => unknown)(input);

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
