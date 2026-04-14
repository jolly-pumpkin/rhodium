import { describe, it, expect } from 'bun:test';
import { createPipelineRunnerPlugin } from './plugin.js';
import type { Plugin, PluginContext } from 'rhodium-core';
import type { PipelineRunner } from './plugin.js';
import type { PipelineSpec } from './spec.js';

describe('pipeline-runner plugin', () => {
  it('has correct manifest shape', () => {
    const plugin = createPipelineRunnerPlugin();
    expect(plugin.key).toBe('pipeline-runner');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.manifest.provides).toEqual([{ capability: 'pipeline-runner' }]);
    expect(plugin.manifest.needs).toEqual([]);
  });

  it('conforms to Plugin interface', () => {
    const plugin: Plugin = createPipelineRunnerPlugin();
    expect(plugin.activate).toBeDefined();
  });

  it('activate provides a runner that executes a pipeline via the broker facade', async () => {
    let providedRunner: unknown;

    // Minimal mock PluginContext that captures the provided value
    const mockCtx: PluginContext = {
      resolve: (cap: string) => {
        if (cap === 'greeter') return (input: unknown) => `hello-${(input as { name: string }).name}`;
        throw new Error(`Unknown: ${cap}`);
      },
      resolveAll: <T>(cap: string): T[] => {
        if (cap === 'greeter') return [(input: unknown) => `hello-${(input as { name: string }).name}`] as T[];
        return [];
      },
      resolveOptional: () => undefined,
      provide: (_cap: string, value: unknown) => { providedRunner = value; },
      registerCommand: () => {},
      reportError: () => {},
      emit: () => {},
    };

    const plugin = createPipelineRunnerPlugin();
    plugin.activate!(mockCtx);

    const runner = providedRunner as PipelineRunner;
    expect(typeof runner.run).toBe('function');

    const spec: PipelineSpec = {
      name: 'test',
      stages: [{ id: 'greet', capability: 'greeter', policy: 'single', errorPolicy: 'fail-fast' }],
      termination: { maxIterations: 1 },
    };

    const result = await runner.run(spec, { name: 'world' });
    expect(result.stageOutputs.get('greet')).toBe('hello-world');
  });
});
