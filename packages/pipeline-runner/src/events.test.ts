import { describe, it, expect } from 'bun:test';
import {
  PIPELINE_EVENTS,
  STAGE_EVENTS,
  PROVIDER_EVENTS,
} from './events.js';

describe('event constants', () => {
  it('defines pipeline lifecycle events', () => {
    expect(PIPELINE_EVENTS.STARTED).toBe('pipeline:started');
    expect(PIPELINE_EVENTS.COMPLETE).toBe('pipeline:complete');
    expect(PIPELINE_EVENTS.FAILED).toBe('pipeline:failed');
    expect(PIPELINE_EVENTS.HALTED_ITERATION_LIMIT).toBe('pipeline:halted-iteration-limit');
  });

  it('defines stage lifecycle events', () => {
    expect(STAGE_EVENTS.STARTED).toBe('stage:started');
    expect(STAGE_EVENTS.COMPLETE).toBe('stage:complete');
    expect(STAGE_EVENTS.SKIPPED).toBe('stage:skipped');
    expect(STAGE_EVENTS.DEGRADED).toBe('stage:degraded');
  });

  it('defines provider events', () => {
    expect(PROVIDER_EVENTS.SELECTED).toBe('provider:selected');
    expect(PROVIDER_EVENTS.FAILED).toBe('provider:failed');
    expect(PROVIDER_EVENTS.FANOUT_STARTED).toBe('providers:fanout-started');
    expect(PROVIDER_EVENTS.FANOUT_COMPLETE).toBe('providers:fanout-complete');
  });
});
