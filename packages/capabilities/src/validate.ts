import type { CapabilityContract, CapabilityViolation, CapabilityValidator } from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export function createCapabilityValidator(): CapabilityValidator {
  return {
    validate(contract: CapabilityContract, implementation: unknown): CapabilityViolation[] {
      const { schema } = contract;
      if (schema === undefined) return [];

      const violations: CapabilityViolation[] = [];
      const impl = isObject(implementation) ? implementation : {};

      for (const [methodName, expectedArity] of Object.entries(schema.methods ?? {})) {
        const value = impl[methodName];
        if (typeof value !== 'function') {
          violations.push({
            kind: 'missing-method',
            field: methodName,
            expected: 'function',
            actual: value === undefined ? 'undefined' : typeof value,
          });
        } else if (value.length !== expectedArity) {
          violations.push({
            kind: 'wrong-arity',
            field: methodName,
            expected: String(expectedArity),
            actual: String(value.length),
          });
        }
      }

      for (const propName of schema.properties ?? []) {
        if (impl[propName] === undefined) {
          violations.push({
            kind: 'missing-property',
            field: propName,
            expected: 'defined',
            actual: 'undefined',
          });
        }
      }

      return violations;
    },
  };
}
