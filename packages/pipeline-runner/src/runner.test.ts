import { describe, it, expect } from 'bun:test';
import { runPipeline } from './runner.js';
import type { PipelineSpec } from './spec.js';
import type { ProviderHandle } from './stage.js';

function createMockBrokerFacade(capabilities: Record<string, unknown>) {
  return {
    resolve: (cap: string) => {
      const impl = capabilities[cap];
      if (!impl) throw new Error(`Capability not found: ${cap}`);
      return impl;
    },
    resolveAll: (cap: string): ProviderHandle[] => {
      const impl = capabilities[cap];
      if (!impl) return [];
      if (Array.isArray(impl)) return impl;
      return [{ id: cap, priority: 10, impl: impl as (input: unknown) => unknown }];
    },
  };
}

describe('runPipeline', () => {
  it('executes a single-stage pipeline end-to-end', async () => {
    const spec: PipelineSpec = {
      name: 'simple',
      stages: [
        { id: 'greet', capability: 'greeter', policy: 'single', errorPolicy: 'fail-fast' },
      ],
      termination: { maxIterations: 1 },
    };

    const broker = createMockBrokerFacade({
      greeter: (input: unknown) => `Hello, ${(input as { name: string }).name}!`,
    });

    const events: Array<{ event: string; payload: unknown }> = [];
    const result = await runPipeline(spec, { name: 'World' }, broker, (e, p) => events.push({ event: e, payload: p }));

    expect(result.stageOutputs.get('greet')).toBe('Hello, World!');
    expect(events.some((e) => e.event === 'pipeline:started')).toBe(true);
    expect(events.some((e) => e.event === 'pipeline:complete')).toBe(true);
  });

  it('passes output from one stage as input to the next via inputFrom', async () => {
    const spec: PipelineSpec = {
      name: 'chain',
      stages: [
        { id: 'load', capability: 'loader', policy: 'single', errorPolicy: 'fail-fast' },
        { id: 'transform', capability: 'transformer', policy: 'single', errorPolicy: 'fail-fast', inputFrom: ['load'] },
      ],
      termination: { maxIterations: 1 },
    };

    const broker = createMockBrokerFacade({
      loader: () => ({ rows: [1, 2, 3] }),
      transformer: (input: unknown) => {
        const loaded = (input as { load: { rows: number[] } }).load;
        return { doubled: loaded.rows.map((r) => r * 2) };
      },
    });

    const result = await runPipeline(spec, {}, broker, () => {});

    expect(result.stageOutputs.get('transform')).toEqual({ doubled: [2, 4, 6] });
  });

  it('composes input from multiple prior stages', async () => {
    const spec: PipelineSpec = {
      name: 'multi-input',
      stages: [
        { id: 'a', capability: 'cap-a', policy: 'single', errorPolicy: 'fail-fast' },
        { id: 'b', capability: 'cap-b', policy: 'single', errorPolicy: 'fail-fast' },
        { id: 'c', capability: 'cap-c', policy: 'single', errorPolicy: 'fail-fast', inputFrom: ['a', 'b'] },
      ],
      termination: { maxIterations: 1 },
    };

    const broker = createMockBrokerFacade({
      'cap-a': () => 'from-a',
      'cap-b': () => 'from-b',
      'cap-c': (input: unknown) => {
        const typed = input as { a: string; b: string };
        return `${typed.a}+${typed.b}`;
      },
    });

    const result = await runPipeline(spec, {}, broker, () => {});

    expect(result.stageOutputs.get('c')).toBe('from-a+from-b');
  });

  it('respects maxIterations', async () => {
    const spec: PipelineSpec = {
      name: 'bounded',
      stages: [
        { id: 'step', capability: 'counter', policy: 'single', errorPolicy: 'fail-fast' },
      ],
      termination: { maxIterations: 3 },
    };

    let callCount = 0;
    const broker = createMockBrokerFacade({
      counter: () => ++callCount,
    });

    const events: Array<{ event: string; payload: unknown }> = [];
    const result = await runPipeline(spec, {}, broker, (e, p) => events.push({ event: e, payload: p }));

    expect(callCount).toBe(3);
    expect(events.some((e) => e.event === 'pipeline:halted-iteration-limit')).toBe(true);
  });

  it('stops early when stop condition returns true', async () => {
    const spec: PipelineSpec = {
      name: 'early-stop',
      stages: [
        { id: 'step', capability: 'worker', policy: 'single', errorPolicy: 'fail-fast' },
      ],
      termination: {
        maxIterations: 10,
        stopCondition: { capability: 'should-stop' },
      },
    };

    let iteration = 0;
    const broker = createMockBrokerFacade({
      worker: () => ++iteration,
      'should-stop': (ctx: unknown) => {
        const typed = ctx as { iteration: number };
        return typed.iteration >= 2;
      },
    });

    const result = await runPipeline(spec, {}, broker, () => {});

    expect(iteration).toBe(2);
    expect(result.stopped).toBe(true);
  });

  it('emits pipeline:failed on stage error with fail-fast, including stage id', async () => {
    const spec: PipelineSpec = {
      name: 'failing',
      stages: [
        { id: 'boom', capability: 'broken', policy: 'single', errorPolicy: 'fail-fast' },
      ],
      termination: { maxIterations: 1 },
    };

    const broker = createMockBrokerFacade({
      broken: () => { throw new Error('kaboom'); },
    });

    const events: Array<{ event: string; payload: unknown }> = [];

    await expect(
      runPipeline(spec, {}, broker, (e, p) => events.push({ event: e, payload: p })),
    ).rejects.toThrow('kaboom');

    const failedEvent = events.find((e) => e.event === 'pipeline:failed');
    expect(failedEvent).toBeDefined();
    expect((failedEvent?.payload as { failedStageId: string }).failedStageId).toBe('boom');
  });

  it('throws on unknown inputFrom stage id', async () => {
    const spec: PipelineSpec = {
      name: 'bad-ref',
      stages: [
        { id: 'a', capability: 'cap-a', policy: 'single', errorPolicy: 'fail-fast' },
        { id: 'b', capability: 'cap-b', policy: 'single', errorPolicy: 'fail-fast', inputFrom: ['nonexistent'] },
      ],
      termination: { maxIterations: 1 },
    };

    const broker = createMockBrokerFacade({
      'cap-a': () => 'a-out',
      'cap-b': () => 'b-out',
    });

    await expect(
      runPipeline(spec, {}, broker, () => {}),
    ).rejects.toThrow(/unknown inputFrom stage/);
  });

  it('accumulates stageOutputs across iterations for multi-iteration pipelines', async () => {
    const spec: PipelineSpec = {
      name: 'multi-iter',
      stages: [
        { id: 'counter', capability: 'increment', policy: 'single', errorPolicy: 'fail-fast' },
        { id: 'reader', capability: 'read-counter', policy: 'single', errorPolicy: 'fail-fast', inputFrom: ['counter'] },
      ],
      termination: { maxIterations: 2 },
    };

    let count = 0;
    const broker = createMockBrokerFacade({
      increment: () => ++count,
      'read-counter': (input: unknown) => (input as { counter: number }).counter,
    });

    const result = await runPipeline(spec, {}, broker, () => {});

    // After 2 iterations the counter stage ran twice; stageOutputs holds iteration 2's value
    expect(result.stageOutputs.get('counter')).toBe(2);
    expect(result.stageOutputs.get('reader')).toBe(2);
    expect(result.iteration).toBe(2);
  });

  it('throws when stop-condition capability resolves to a non-function', async () => {
    const spec: PipelineSpec = {
      name: 'bad-stopper',
      stages: [
        { id: 'step', capability: 'worker', policy: 'single', errorPolicy: 'fail-fast' },
      ],
      termination: { maxIterations: 5, stopCondition: { capability: 'not-a-fn' } },
    };

    const broker = createMockBrokerFacade({
      worker: () => 'done',
      'not-a-fn': 'oops',
    });

    await expect(
      runPipeline(spec, {}, broker, () => {}),
    ).rejects.toThrow(/did not resolve to a function/);
  });
});
