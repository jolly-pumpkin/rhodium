import { describe, it, expect } from 'bun:test';
import { executeSingleStage } from './stage.js';
import type { StageSpec, PipelineContext, SchemaRef } from './spec.js';

// Minimal emit collector
function createEmitter() {
  const events: Array<{ event: string; payload: unknown }> = [];
  return {
    emit: (event: string, payload: unknown) => events.push({ event, payload }),
    events,
  };
}

describe('executeSingleStage', () => {
  const baseContext: PipelineContext = {
    specName: 'test',
    runId: 'run-1',
    stageOutputs: new Map(),
    iteration: 0,
    startedAt: Date.now(),
    stopped: false,
  };

  it('resolves capability, invokes provider, stores output', async () => {
    const stage: StageSpec = {
      id: 'load',
      capability: 'loader',
      policy: 'single',
      errorPolicy: 'fail-fast',
    };

    const resolve = (cap: string) => {
      if (cap === 'loader') return (input: unknown) => ({ data: 'loaded' });
      throw new Error(`Unknown capability: ${cap}`);
    };

    const { emit, events } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeSingleStage(stage, ctx, { foo: 'bar' }, resolve, emit);

    expect(ctx.stageOutputs.get('load')).toEqual({ data: 'loaded' });
    expect(events.some((e) => e.event === 'stage:complete')).toBe(true);
  });

  it('throws on fail-fast when provider is missing', async () => {
    const stage: StageSpec = {
      id: 'missing',
      capability: 'nonexistent',
      policy: 'single',
      errorPolicy: 'fail-fast',
    };

    const resolve = () => { throw new Error('not found'); };
    const { emit } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await expect(
      executeSingleStage(stage, ctx, {}, resolve, emit),
    ).rejects.toThrow();
  });

  it('skips stage when errorPolicy is skip and provider is missing', async () => {
    const stage: StageSpec = {
      id: 'optional',
      capability: 'nonexistent',
      policy: 'single',
      errorPolicy: 'skip',
    };

    const resolve = () => { throw new Error('not found'); };
    const { emit, events } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeSingleStage(stage, ctx, {}, resolve, emit);

    expect(ctx.stageOutputs.has('optional')).toBe(false);
    expect(events.some((e) => e.event === 'stage:skipped')).toBe(true);
  });

  it('validates input schema and fails fast on mismatch', async () => {
    const failingSchema: SchemaRef = {
      validate: () => ['missing required field'],
    };
    const stage: StageSpec = {
      id: 'validated',
      capability: 'loader',
      policy: 'single',
      errorPolicy: 'fail-fast',
      inputSchema: failingSchema,
    };

    const resolve = () => () => 'should not run';
    const { emit } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await expect(
      executeSingleStage(stage, ctx, {}, resolve, emit),
    ).rejects.toThrow(/validation/i);
  });

  it('validates output schema and fails fast on mismatch', async () => {
    const failingSchema: SchemaRef = {
      validate: () => ['output field missing'],
    };
    const stage: StageSpec = {
      id: 'bad-output',
      capability: 'loader',
      policy: 'single',
      errorPolicy: 'fail-fast',
      outputSchema: failingSchema,
    };

    const resolve = () => () => 'bad data';
    const { emit } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await expect(
      executeSingleStage(stage, ctx, {}, resolve, emit),
    ).rejects.toThrow(/validation/i);
  });
});
