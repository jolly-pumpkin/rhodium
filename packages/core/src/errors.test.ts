import { describe, test, expect, beforeEach } from 'bun:test';
import {
  RhodiumError,
  CapabilityNotFoundError,
  CircularDependencyError,
  ActivationTimeoutError,
  ActivationError,
  CapabilityViolationError,
  DuplicatePluginError,
  UndeclaredCapabilityError,
} from './errors.js';

// ============================================================
// RhodiumError base class
// ============================================================

describe('RhodiumError', () => {
  test('sets code, pluginKey, and timestamp', () => {
    const before = Date.now();
    const err = new RhodiumError('test message', 'TEST_CODE', 'my-plugin');
    const after = Date.now();

    expect(err.message).toBe('test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.pluginKey).toBe('my-plugin');
    expect(err.timestamp).toBeGreaterThanOrEqual(before);
    expect(err.timestamp).toBeLessThanOrEqual(after);
  });

  test('pluginKey is optional', () => {
    const err = new RhodiumError('test', 'TEST_CODE');
    expect(err.pluginKey).toBeUndefined();
  });

  test('name is set to class name', () => {
    const err = new RhodiumError('test', 'TEST_CODE');
    expect(err.name).toBe('RhodiumError');
  });

  test('is an instance of Error', () => {
    const err = new RhodiumError('test', 'TEST_CODE');
    expect(err instanceof Error).toBe(true);
  });

  test('has static CODE', () => {
    expect(RhodiumError.CODE).toBe('RHODIUM_ERROR');
  });
});

// ============================================================
// Static CODE constants
// ============================================================

describe('static CODE constants', () => {
  test('each error class has a unique CODE', () => {
    const codes = [
      RhodiumError.CODE,
      CapabilityNotFoundError.CODE,
      CircularDependencyError.CODE,
      ActivationTimeoutError.CODE,
      ActivationError.CODE,
      CapabilityViolationError.CODE,
      DuplicatePluginError.CODE,
      UndeclaredCapabilityError.CODE,
    ];
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });

  test('CapabilityNotFoundError.CODE is CAPABILITY_NOT_FOUND', () => {
    expect(CapabilityNotFoundError.CODE).toBe('CAPABILITY_NOT_FOUND');
  });

  test('CircularDependencyError.CODE is CIRCULAR_DEPENDENCY', () => {
    expect(CircularDependencyError.CODE).toBe('CIRCULAR_DEPENDENCY');
  });

  test('ActivationTimeoutError.CODE is ACTIVATION_TIMEOUT', () => {
    expect(ActivationTimeoutError.CODE).toBe('ACTIVATION_TIMEOUT');
  });

  test('ActivationError.CODE is ACTIVATION_FAILED', () => {
    expect(ActivationError.CODE).toBe('ACTIVATION_FAILED');
  });

  test('CapabilityViolationError.CODE is CAPABILITY_VIOLATION', () => {
    expect(CapabilityViolationError.CODE).toBe('CAPABILITY_VIOLATION');
  });

  test('DuplicatePluginError.CODE is DUPLICATE_PLUGIN', () => {
    expect(DuplicatePluginError.CODE).toBe('DUPLICATE_PLUGIN');
  });

  test('UndeclaredCapabilityError.CODE is UNDECLARED_CAPABILITY', () => {
    expect(UndeclaredCapabilityError.CODE).toBe('UNDECLARED_CAPABILITY');
  });
});

// ============================================================
// instanceof checks
// ============================================================

describe('instanceof RhodiumError', () => {
  test('CapabilityNotFoundError is instanceof RhodiumError', () => {
    const err = new CapabilityNotFoundError('cap', 'plugin', '0.1.0', []);
    expect(err instanceof RhodiumError).toBe(true);
    expect(err instanceof Error).toBe(true);
  });

  test('CircularDependencyError is instanceof RhodiumError', () => {
    const err = new CircularDependencyError(['a', 'b', 'a']);
    expect(err instanceof RhodiumError).toBe(true);
  });

  test('ActivationTimeoutError is instanceof RhodiumError', () => {
    const err = new ActivationTimeoutError('my-plugin', 5000);
    expect(err instanceof RhodiumError).toBe(true);
  });

  test('ActivationError is instanceof RhodiumError', () => {
    const err = new ActivationError('my-plugin', new Error('cause'));
    expect(err instanceof RhodiumError).toBe(true);
  });

  test('CapabilityViolationError is instanceof RhodiumError', () => {
    const err = new CapabilityViolationError('my-plugin', 'code-parser', []);
    expect(err instanceof RhodiumError).toBe(true);
  });

  test('DuplicatePluginError is instanceof RhodiumError', () => {
    const err = new DuplicatePluginError('my-plugin');
    expect(err instanceof RhodiumError).toBe(true);
  });

  test('UndeclaredCapabilityError is instanceof RhodiumError', () => {
    const err = new UndeclaredCapabilityError('my-plugin', 'some-cap');
    expect(err instanceof RhodiumError).toBe(true);
  });
});

// ============================================================
// Error code on instances
// ============================================================

describe('instance .code matches static CODE', () => {
  test('CapabilityNotFoundError', () => {
    const err = new CapabilityNotFoundError('cap', 'plugin', '0.1.0', []);
    expect(err.code).toBe(CapabilityNotFoundError.CODE);
  });

  test('CircularDependencyError', () => {
    const err = new CircularDependencyError(['a', 'b']);
    expect(err.code).toBe(CircularDependencyError.CODE);
  });

  test('ActivationError', () => {
    const err = new ActivationError('plugin', new Error('cause'));
    expect(err.code).toBe(ActivationError.CODE);
    expect(err.pluginKey).toBe('plugin');
  });
});

// ============================================================
// CircularDependencyError message formatting
// ============================================================

describe('CircularDependencyError message formatting', () => {
  let err: CircularDependencyError;
  const cycle = ['orchestrator', 'safety-assessor', 'memory-provider'];

  beforeEach(() => {
    err = new CircularDependencyError(cycle);
  });

  test('includes "Circular dependency detected"', () => {
    expect(err.message).toContain('Circular dependency detected');
  });

  test('includes each plugin in the chain', () => {
    for (const plugin of cycle) {
      expect(err.message).toContain(plugin);
    }
  });

  test('includes ASCII arrows showing the chain', () => {
    expect(err.message).toContain('→ depends on');
  });

  test('annotates the closing of the cycle', () => {
    expect(err.message).toContain('← cycle closes here');
  });

  test('includes "Plugins in cycle:" footer with all plugins', () => {
    expect(err.message).toContain('Plugins in cycle:');
    expect(err.message).toContain('orchestrator, safety-assessor, memory-provider');
  });

  test('handles a 2-plugin cycle', () => {
    const err2 = new CircularDependencyError(['a', 'b']);
    expect(err2.message).toContain('a');
    expect(err2.message).toContain('b');
    expect(err2.message).toContain('← cycle closes here');
  });
});

// ============================================================
// CapabilityNotFoundError message formatting
// ============================================================

describe('CapabilityNotFoundError message formatting', () => {
  let err: CapabilityNotFoundError;

  beforeEach(() => {
    err = new CapabilityNotFoundError(
      'memory-provider',
      'orchestrator',
      '0.1.0',
      ['code-parser', 'flag-environment', 'cleanup-rule']
    );
  });

  test('includes the missing capability name', () => {
    expect(err.message).toContain('memory-provider');
  });

  test('includes "Needed by" with plugin name', () => {
    expect(err.message).toContain('Needed by');
    expect(err.message).toContain('orchestrator');
  });

  test('includes version in Needed by line', () => {
    expect(err.message).toContain('0.1.0');
  });

  test('includes "Declared as: required"', () => {
    expect(err.message).toContain('required');
  });

  test('lists available capabilities', () => {
    expect(err.message).toContain('code-parser');
    expect(err.message).toContain('flag-environment');
    expect(err.message).toContain('cleanup-rule');
  });

  test('includes hint to register or mark optional', () => {
    expect(err.message).toContain('optional: true');
  });

  test('sets pluginKey to neededBy', () => {
    expect(err.pluginKey).toBe('orchestrator');
  });

  test('handles empty available list', () => {
    const err2 = new CapabilityNotFoundError('cap', 'plugin', '1.0.0', []);
    expect(err2.message).toContain('cap');
    expect(err2.message).toContain('plugin');
  });
});

// ============================================================
// CapabilityViolationError message formatting
// ============================================================

describe('CapabilityViolationError message formatting', () => {
  test('includes plugin key and capability name', () => {
    const err = new CapabilityViolationError('custom-parser', 'code-parser', []);
    expect(err.message).toContain('custom-parser');
    expect(err.message).toContain('code-parser');
  });

  test('lists missing methods', () => {
    const err = new CapabilityViolationError('custom-parser', 'code-parser', [
      { kind: 'missing-method', field: 'applyTransform', expected: 'function', actual: 'undefined' },
    ]);
    expect(err.message).toContain('Missing methods');
    expect(err.message).toContain('applyTransform');
  });

  test('lists missing properties', () => {
    const err = new CapabilityViolationError('my-plugin', 'some-cap', [
      { kind: 'missing-property', field: 'version', expected: 'string', actual: 'undefined' },
    ]);
    expect(err.message).toContain('Missing properties');
    expect(err.message).toContain('version');
  });

  test('lists wrong-arity violations with expected and actual', () => {
    const err = new CapabilityViolationError('custom-parser', 'code-parser', [
      { kind: 'wrong-arity', field: 'findFlagUsages', expected: '2', actual: '1' },
    ]);
    expect(err.message).toContain('Wrong arity');
    expect(err.message).toContain('findFlagUsages');
    expect(err.message).toContain('expected 2');
    expect(err.message).toContain('got 1');
  });

  test('lists wrong-type violations', () => {
    const err = new CapabilityViolationError('my-plugin', 'some-cap', [
      { kind: 'wrong-type', field: 'id', expected: 'string', actual: 'number' },
    ]);
    expect(err.message).toContain('Wrong types');
    expect(err.message).toContain('id');
  });

  test('groups multiple violations by kind', () => {
    const err = new CapabilityViolationError('custom-parser', 'code-parser', [
      { kind: 'missing-method', field: 'applyTransform', expected: 'function', actual: 'undefined' },
      { kind: 'wrong-arity', field: 'findFlagUsages', expected: '2', actual: '1' },
    ]);
    expect(err.message).toContain('Missing methods');
    expect(err.message).toContain('Wrong arity');
  });

  test('sets pluginKey', () => {
    const err = new CapabilityViolationError('custom-parser', 'code-parser', []);
    expect(err.pluginKey).toBe('custom-parser');
  });
});

// ============================================================
// Remaining error classes — basic behavior
// ============================================================

describe('ActivationTimeoutError', () => {
  test('includes plugin key and timeout in message', () => {
    const err = new ActivationTimeoutError('slow-plugin', 5000);
    expect(err.message).toContain('slow-plugin');
    expect(err.message).toContain('5000');
    expect(err.pluginKey).toBe('slow-plugin');
    expect(err.code).toBe('ACTIVATION_TIMEOUT');
  });
});

describe('ActivationError', () => {
  test('includes plugin key and cause message', () => {
    const cause = new Error('network timeout');
    const err = new ActivationError('my-plugin', cause);
    expect(err.message).toContain('my-plugin');
    expect(err.message).toContain('network timeout');
    expect(err.pluginKey).toBe('my-plugin');
    expect(err.code).toBe('ACTIVATION_FAILED');
  });
});

describe('DuplicatePluginError', () => {
  test('includes plugin key in message', () => {
    const err = new DuplicatePluginError('my-plugin');
    expect(err.message).toContain('my-plugin');
    expect(err.pluginKey).toBe('my-plugin');
    expect(err.code).toBe('DUPLICATE_PLUGIN');
  });
});

describe('UndeclaredCapabilityError', () => {
  test('includes plugin key and capability in message', () => {
    const err = new UndeclaredCapabilityError('my-plugin', 'some-cap');
    expect(err.message).toContain('my-plugin');
    expect(err.message).toContain('some-cap');
    expect(err.pluginKey).toBe('my-plugin');
    expect(err.code).toBe('UNDECLARED_CAPABILITY');
  });
});
