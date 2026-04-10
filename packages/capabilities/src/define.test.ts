import { describe, test, expect } from 'bun:test';
import { defineCapability } from './define.js';

// ============================================================
// defineCapability
// ============================================================

describe('defineCapability', () => {
  test('returns a contract with the given name', () => {
    const cap = defineCapability('my-service');
    expect(cap.name).toBe('my-service');
  });

  test('_type is undefined at runtime (phantom type)', () => {
    const cap = defineCapability<{ doThing(): void }>('my-service');
    expect(cap._type).toBeUndefined();
  });

  test('without schema, schema is undefined', () => {
    const cap = defineCapability('my-service');
    expect(cap.schema).toBeUndefined();
  });

  test('with schema, schema is preserved on the token', () => {
    const schema = {
      methods: { greet: 1 },
      properties: ['name'],
    };
    const cap = defineCapability('greeter', schema);
    expect(cap.schema).toEqual(schema);
  });

  test('name is readonly (TypeScript-level; runtime value is stable)', () => {
    const cap = defineCapability('foo');
    expect(cap.name).toBe('foo');
  });
});
