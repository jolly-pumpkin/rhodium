import { describe, it, expect } from 'bun:test';
import type { PipelineSpec, StageSpec, TerminationPolicy, ReducerRef } from './spec.js';

describe('PipelineSpec types', () => {
  it('accepts a valid single-stage spec', () => {
    const spec: PipelineSpec = {
      name: 'test-pipeline',
      stages: [
        {
          id: 'load',
          capability: 'dataset-loader',
          policy: 'single',
          errorPolicy: 'fail-fast',
        },
      ],
      termination: { maxIterations: 1 },
    };
    expect(spec.name).toBe('test-pipeline');
    expect(spec.stages).toHaveLength(1);
    expect(spec.termination.maxIterations).toBe(1);
  });

  it('accepts a fanout stage with reducer and schemas', () => {
    const stage: StageSpec = {
      id: 'analyze',
      capability: 'analysis-angle',
      policy: 'fanout',
      reducer: { kind: 'concat' },
      inputFrom: ['load'],
      errorPolicy: 'fall-through',
    };
    expect(stage.policy).toBe('fanout');
    expect(stage.reducer).toEqual({ kind: 'concat' });
  });

  it('accepts a custom reducer ref', () => {
    const reducer: ReducerRef = { kind: 'custom', capability: 'my-reducer' };
    expect(reducer.kind).toBe('custom');
  });

  it('accepts a stop-condition termination policy', () => {
    const term: TerminationPolicy = {
      maxIterations: 5,
      stopCondition: { capability: 'quality-checker' },
    };
    expect(term.stopCondition?.capability).toBe('quality-checker');
  });
});
