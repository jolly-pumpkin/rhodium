import { describe, it, expect } from 'bun:test';
import { validateStageData } from './validate.js';
import type { SchemaRef } from './spec.js';

describe('validateStageData', () => {
  const passingSchema: SchemaRef = {
    validate: () => [],
  };

  const failingSchema: SchemaRef = {
    validate: () => ['field "name" is required', 'field "age" must be number'],
  };

  it('returns ok when no schema is provided', () => {
    const result = validateStageData('stage-1', 'input', undefined, { foo: 'bar' });
    expect(result.ok).toBe(true);
  });

  it('returns ok when schema passes', () => {
    const result = validateStageData('stage-1', 'input', passingSchema, { foo: 'bar' });
    expect(result.ok).toBe(true);
  });

  it('returns errors when schema fails', () => {
    const result = validateStageData('stage-1', 'input', failingSchema, { foo: 'bar' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stageId).toBe('stage-1');
      expect(result.phase).toBe('input');
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0]).toContain('name');
    }
  });
});
