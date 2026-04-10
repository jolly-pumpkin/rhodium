import { describe, test, expect } from 'bun:test';
import { createCapabilityValidator } from './validate.js';
import { defineCapability } from './define.js';
import type { CapabilityViolation } from './types.js';

// ============================================================
// createCapabilityValidator
// ============================================================

describe('createCapabilityValidator', () => {
  const validator = createCapabilityValidator();

  // -- No schema (trivial pass) ---------------------------------

  test('returns [] when contract has no schema', () => {
    const contract = defineCapability('no-schema');
    const impl = { anything: true };
    expect(validator.validate(contract, impl)).toEqual([]);
  });

  // -- Conforming implementation --------------------------------

  test('returns [] for a fully conforming implementation', () => {
    const contract = defineCapability('greeter', {
      methods: { greet: 1 },
      properties: ['name'],
    });
    const impl = {
      name: 'English Greeter',
      greet(who: string) { return `Hello ${who}`; },
    };
    expect(validator.validate(contract, impl)).toEqual([]);
  });

  // -- Missing method -------------------------------------------

  test('reports missing-method when a required method is absent', () => {
    const contract = defineCapability('greeter', {
      methods: { greet: 1 },
    });
    const impl = {};
    const violations = validator.validate(contract, impl);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('missing-method');
    expect(violations[0]!.field).toBe('greet');
  });

  test('reports missing-method when field exists but is not a function', () => {
    const contract = defineCapability('greeter', {
      methods: { greet: 1 },
    });
    const impl = { greet: 'not-a-function' };
    const violations = validator.validate(contract, impl);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('missing-method');
    expect(violations[0]!.field).toBe('greet');
  });

  // -- Missing property ----------------------------------------

  test('reports missing-property when a required property is absent', () => {
    const contract = defineCapability('greeter', {
      properties: ['name'],
    });
    const impl = {};
    const violations = validator.validate(contract, impl);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('missing-property');
    expect(violations[0]!.field).toBe('name');
  });

  test('reports missing-property when property value is undefined', () => {
    const contract = defineCapability('greeter', {
      properties: ['name'],
    });
    const impl = { name: undefined };
    const violations = validator.validate(contract, impl);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('missing-property');
  });

  // -- Wrong arity ---------------------------------------------

  test('reports wrong-arity when method has incorrect parameter count', () => {
    const contract = defineCapability('parser', {
      methods: { parse: 2 },
    });
    const impl = { parse(x: string) { return x; } }; // arity 1, expected 2
    const violations = validator.validate(contract, impl);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.kind).toBe('wrong-arity');
    expect(violations[0]!.field).toBe('parse');
    expect(violations[0]!.expected).toBe('2');
    expect(violations[0]!.actual).toBe('1');
  });

  // -- Multiple violations -------------------------------------

  test('returns all violations when multiple mismatches exist', () => {
    const contract = defineCapability('complex', {
      methods: { doA: 1, doB: 2 },
      properties: ['config', 'version'],
    });
    // impl missing doA, doB has wrong arity, config missing, version missing
    const impl = { doB(x: string) { return x; } }; // arity 1, expected 2
    const violations = validator.validate(contract, impl);
    const kinds = violations.map((v: CapabilityViolation) => v.kind);
    expect(kinds).toContain('missing-method'); // doA
    expect(kinds).toContain('wrong-arity');    // doB
    expect(kinds).toContain('missing-property'); // config
    expect(kinds).toContain('missing-property'); // version
    expect(violations).toHaveLength(4);
  });

  // -- Non-object implementation --------------------------------

  test('reports violations for null implementation', () => {
    const contract = defineCapability('greeter', {
      methods: { greet: 1 },
      properties: ['name'],
    });
    const violations = validator.validate(contract, null);
    // All methods and properties should be reported as missing
    expect(violations.length).toBeGreaterThanOrEqual(2);
  });
});
