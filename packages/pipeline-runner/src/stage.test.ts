import { describe, it, expect } from 'bun:test';
import { executeSingleStage, executeFanoutStage } from './stage.js';
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

  it('skips stage when errorPolicy is skip and provider throws during execution', async () => {
    const stage: StageSpec = {
      id: 'throwing',
      capability: 'boom',
      policy: 'single',
      errorPolicy: 'skip',
    };

    const resolve = () => () => { throw new Error('execution error'); };
    const { emit, events } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeSingleStage(stage, ctx, {}, resolve, emit);

    expect(ctx.stageOutputs.has('throwing')).toBe(false);
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

describe('executeFanoutStage', () => {
  const baseContext: PipelineContext = {
    specName: 'test',
    runId: 'run-1',
    stageOutputs: new Map(),
    iteration: 0,
    startedAt: Date.now(),
    stopped: false,
  };

  it('fans out to all providers and reduces with concat', async () => {
    const stage: StageSpec = {
      id: 'analyze',
      capability: 'angle',
      policy: 'fanout',
      reducer: { kind: 'concat' },
      errorPolicy: 'fail-fast',
    };

    const providers = [
      { id: 'angle-a', priority: 10, impl: (input: unknown) => ({ angle: 'A' }) },
      { id: 'angle-b', priority: 5, impl: (input: unknown) => ({ angle: 'B' }) },
    ];

    const resolveAll = (cap: string) => {
      if (cap === 'angle') return providers;
      return [];
    };

    const { emit, events } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeFanoutStage(stage, ctx, { data: 'test' }, resolveAll, emit);

    expect(ctx.stageOutputs.get('analyze')).toEqual([{ angle: 'A' }, { angle: 'B' }]);
    expect(events.some((e) => e.event === 'providers:fanout-started')).toBe(true);
    expect(events.some((e) => e.event === 'providers:fanout-complete')).toBe(true);
  });

  it('reduces with priority-pick', async () => {
    const stage: StageSpec = {
      id: 'pick',
      capability: 'angle',
      policy: 'fanout',
      reducer: { kind: 'priority-pick' },
      errorPolicy: 'fail-fast',
    };

    const providers = [
      { id: 'low', priority: 1, impl: () => 'low-value' },
      { id: 'high', priority: 10, impl: () => 'high-value' },
    ];

    const resolveAll = () => providers;
    const { emit } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeFanoutStage(stage, ctx, {}, resolveAll, emit);

    expect(ctx.stageOutputs.get('pick')).toBe('high-value');
  });

  it('isolates per-provider errors and emits provider:failed', async () => {
    const stage: StageSpec = {
      id: 'partial',
      capability: 'angle',
      policy: 'fanout',
      reducer: { kind: 'concat' },
      errorPolicy: 'fall-through',
    };

    const providers = [
      { id: 'good', priority: 10, impl: () => 'ok' },
      { id: 'bad', priority: 5, impl: () => { throw new Error('boom'); } },
    ];

    const resolveAll = () => providers;
    const { emit, events } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeFanoutStage(stage, ctx, {}, resolveAll, emit);

    expect(ctx.stageOutputs.get('partial')).toEqual(['ok']);
    expect(events.some((e) => e.event === 'provider:failed')).toBe(true);
  });

  it('emits stage:degraded when all providers fail with fall-through', async () => {
    const stage: StageSpec = {
      id: 'all-fail',
      capability: 'angle',
      policy: 'fanout',
      reducer: { kind: 'concat' },
      errorPolicy: 'fall-through',
    };

    const providers = [
      { id: 'bad1', priority: 10, impl: () => { throw new Error('a'); } },
      { id: 'bad2', priority: 5, impl: () => { throw new Error('b'); } },
    ];

    const resolveAll = () => providers;
    const { emit, events } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await executeFanoutStage(stage, ctx, {}, resolveAll, emit);

    expect(ctx.stageOutputs.get('all-fail')).toBeNull();
    expect(events.some((e) => e.event === 'stage:degraded')).toBe(true);
  });

  it('throws when all providers fail with fail-fast policy', async () => {
    const stage: StageSpec = {
      id: 'strict',
      capability: 'angle',
      policy: 'fanout',
      reducer: { kind: 'concat' },
      errorPolicy: 'fail-fast',
    };

    const providers = [
      { id: 'bad', priority: 10, impl: () => { throw new Error('boom'); } },
    ];

    const resolveAll = () => providers;
    const { emit } = createEmitter();
    const ctx = { ...baseContext, stageOutputs: new Map() };

    await expect(
      executeFanoutStage(stage, ctx, {}, resolveAll, emit),
    ).rejects.toThrow();
  });
});
