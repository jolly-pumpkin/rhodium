import { describe, it, expect } from 'bun:test';
import { concatReducer, priorityPickReducer } from './reducers.js';

describe('concatReducer', () => {
  it('collects all outputs into an array preserving input order', () => {
    const results = [
      { providerId: 'a', priority: 5, output: ['x', 'y'] },
      { providerId: 'b', priority: 10, output: ['z'] },
    ];
    expect(concatReducer(results)).toEqual([['x', 'y'], ['z']]);
  });

  it('returns empty array for no results', () => {
    expect(concatReducer([])).toEqual([]);
  });
});

describe('priorityPickReducer', () => {
  it('returns the output of the highest-priority provider', () => {
    const results = [
      { providerId: 'a', priority: 5, output: 'low' },
      { providerId: 'b', priority: 10, output: 'high' },
      { providerId: 'c', priority: 7, output: 'mid' },
    ];
    expect(priorityPickReducer(results)).toBe('high');
  });

  it('returns undefined for no results', () => {
    expect(priorityPickReducer([])).toBeUndefined();
  });

  it('returns first result when priorities are tied (first-wins)', () => {
    const results = [
      { providerId: 'a', priority: 5, output: 'first' },
      { providerId: 'b', priority: 5, output: 'second' },
    ];
    expect(priorityPickReducer(results)).toBe('first');
  });
});
