import { describe, it, expect } from 'bun:test';
import { createPipelineRunnerPlugin } from './plugin.js';
import type { Plugin } from 'rhodium-core';

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
});
