import { describe, it, expect } from 'bun:test';
import { createDependencyGraph, createCapabilityResolver } from './index';

describe('graph exports', () => {
  it('exports createDependencyGraph', () => {
    expect(typeof createDependencyGraph).toBe('function');
  });

  it('exports createCapabilityResolver', () => {
    expect(typeof createCapabilityResolver).toBe('function');
  });
});
