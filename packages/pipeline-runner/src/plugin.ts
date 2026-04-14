import type { Plugin, PluginContext } from 'rhodium-core';
import type { PipelineSpec } from './spec.js';
import type { PipelineResult } from './runner.js';
import type { ProviderHandle } from './stage.js';
import { runPipeline } from './runner.js';

export interface PipelineRunner {
  run(spec: PipelineSpec, initialInput: unknown): Promise<PipelineResult>;
}

export function createPipelineRunnerPlugin(): Plugin {
  return {
    key: 'pipeline-runner',
    version: '0.1.0',
    manifest: {
      name: 'Pipeline Runner',
      description: 'Executes declared pipeline specs over broker-resolved capabilities',
      provides: [{ capability: 'pipeline-runner' }],
      needs: [],
    },
    activate(ctx: PluginContext) {
      const runner: PipelineRunner = {
        async run(spec, initialInput) {
          const brokerFacade = {
            resolve: (cap: string) => ctx.resolve(cap),
            resolveAll: (cap: string): ProviderHandle[] => {
              const impls = ctx.resolveAll<unknown>(cap);
              return impls.map((impl, i) => ({
                id: `${cap}-${i}`,
                priority: 0,
                impl: typeof impl === 'function' ? impl as (input: unknown) => unknown : () => impl,
              }));
            },
          };
          return runPipeline(spec, initialInput, brokerFacade, (event, payload) => {
            ctx.emit(event, payload);
          });
        },
      };

      ctx.provide('pipeline-runner', runner);
    },
  };
}
