import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { createBroker } from 'rhodium-core';
import type { Broker, Plugin } from 'rhodium-core';
import { createPipelineRunnerPlugin } from './plugin.js';
import type { PipelineRunner } from './plugin.js';
import type { PipelineSpec } from './spec.js';

// ── Toy plugins ──────────────────────────────────────────────────

const loaderPlugin: Plugin = {
  key: 'csv-loader',
  version: '1.0.0',
  manifest: {
    name: 'CSV Loader',
    description: 'Loads a dataset',
    provides: [{ capability: 'dataset-loader' }],
    needs: [],
  },
  activate(ctx) {
    ctx.provide('dataset-loader', (input: unknown) => {
      return { rows: [1, 2, 3, 4, 5], source: 'csv' };
    });
  },
};

const statAnglePlugin: Plugin = {
  key: 'statistical-summary',
  version: '1.0.0',
  manifest: {
    name: 'Statistical Summary',
    description: 'Provides statistical analysis angle',
    provides: [{ capability: 'analysis-angle' }],
    needs: [],
  },
  activate(ctx) {
    ctx.provide('analysis-angle', (input: unknown) => {
      // inputFrom: ['load'] composes input as { load: { rows, source } }
      const data = (input as { load: { rows: number[] } }).load;
      const sum = data.rows.reduce((a, b) => a + b, 0);
      return { angle: 'statistics', mean: sum / data.rows.length };
    });
  },
};

const outlierAnglePlugin: Plugin = {
  key: 'outlier-detector',
  version: '1.0.0',
  manifest: {
    name: 'Outlier Detector',
    description: 'Detects outliers',
    provides: [{ capability: 'analysis-angle' }],
    needs: [],
  },
  activate(ctx) {
    ctx.provide('analysis-angle', (input: unknown) => {
      return { angle: 'outliers', count: 0 };
    });
  },
};

const synthesizerPlugin: Plugin = {
  key: 'reflection-synthesizer',
  version: '1.0.0',
  manifest: {
    name: 'Reflection Synthesizer',
    description: 'Synthesizes analysis results',
    provides: [{ capability: 'reflection-synthesis' }],
    needs: [],
  },
  activate(ctx) {
    ctx.provide('reflection-synthesis', (input: unknown) => {
      const typed = input as { load: { rows: number[]; source: string }; analyze: unknown[] };
      return {
        summary: `Synthesized ${typed.analyze.length} angles over ${typed.load.rows.length} rows`,
        angles: typed.analyze,
      };
    });
  },
};

// ── Spec ──────────────────────────────────────────────────────────

const datasetReflectionSpec: PipelineSpec = {
  name: 'dataset-reflection',
  stages: [
    {
      id: 'load',
      capability: 'dataset-loader',
      policy: 'single',
      errorPolicy: 'fail-fast',
    },
    {
      id: 'analyze',
      capability: 'analysis-angle',
      policy: 'fanout',
      inputFrom: ['load'],
      reducer: { kind: 'concat' },
      errorPolicy: 'fall-through',
    },
    {
      id: 'reflect',
      capability: 'reflection-synthesis',
      policy: 'single',
      inputFrom: ['load', 'analyze'],
      errorPolicy: 'fail-fast',
    },
  ],
  termination: { maxIterations: 1 },
};

// ── Tests ─────────────────────────────────────────────────────────

describe('pipeline-runner integration', () => {
  let broker: Broker;
  let runner: PipelineRunner;
  const events: Array<{ event: string; payload: unknown }> = [];

  beforeAll(async () => {
    broker = createBroker();
    broker.register(loaderPlugin);
    broker.register(statAnglePlugin);
    broker.register(outlierAnglePlugin);
    broker.register(synthesizerPlugin);
    broker.register(createPipelineRunnerPlugin());

    for (const evt of [
      'pipeline:started', 'pipeline:complete', 'pipeline:failed', 'pipeline:halted-iteration-limit',
      'stage:started', 'stage:complete', 'stage:skipped', 'stage:degraded',
      'provider:selected', 'provider:failed', 'providers:fanout-started', 'providers:fanout-complete',
    ] as const) {
      broker.on(evt, (payload) => {
        events.push({ event: evt, payload });
      });
    }

    await broker.activate();
    runner = broker.resolve<PipelineRunner>('pipeline-runner');
  });

  afterAll(async () => {
    await broker.deactivate();
  });

  it('resolves the pipeline-runner capability', () => {
    expect(runner).toBeDefined();
    expect(typeof runner.run).toBe('function');
  });

  it('executes the dataset-reflection spec end-to-end', async () => {
    events.length = 0;
    const result = await runner.run(datasetReflectionSpec, {});

    // Load stage produced data
    const loadOutput = result.stageOutputs.get('load') as { rows: number[]; source: string };
    expect(loadOutput.rows).toEqual([1, 2, 3, 4, 5]);
    expect(loadOutput.source).toBe('csv');

    // Analyze stage fanned out to 2 angles
    const analyzeOutput = result.stageOutputs.get('analyze') as unknown[];
    expect(analyzeOutput).toHaveLength(2);

    // Reflect stage synthesized
    const reflectOutput = result.stageOutputs.get('reflect') as { summary: string; angles: unknown[] };
    expect(reflectOutput.summary).toContain('2 angles');
    expect(reflectOutput.summary).toContain('5 rows');
  });

  it('emits a complete event trace', async () => {
    events.length = 0;
    await runner.run(datasetReflectionSpec, {});

    const eventTypes = events.map((e) => e.event);
    expect(eventTypes).toContain('pipeline:started');
    expect(eventTypes).toContain('stage:started');
    expect(eventTypes).toContain('providers:fanout-started');
    expect(eventTypes).toContain('providers:fanout-complete');
    expect(eventTypes).toContain('stage:complete');
    expect(eventTypes).toContain('pipeline:complete');
  });

  it('picks up a new angle plugin without spec or runner changes', async () => {
    const newAngle: Plugin = {
      key: 'distribution-shift',
      version: '1.0.0',
      manifest: {
        name: 'Distribution Shift',
        description: 'Detects distribution shifts',
        provides: [{ capability: 'analysis-angle' }],
        needs: [],
      },
      activate(ctx) {
        ctx.provide('analysis-angle', (_input: unknown) => {
          return { angle: 'distribution-shift', detected: false };
        });
      },
    };
    broker.register(newAngle);
    await broker.activatePlugin('distribution-shift');

    events.length = 0;
    const result = await runner.run(datasetReflectionSpec, {});

    const analyzeOutput = result.stageOutputs.get('analyze') as unknown[];
    expect(analyzeOutput).toHaveLength(3); // was 2, now 3

    const reflectOutput = result.stageOutputs.get('reflect') as { summary: string };
    expect(reflectOutput.summary).toContain('3 angles');
  });
});
