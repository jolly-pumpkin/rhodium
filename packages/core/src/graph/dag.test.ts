import { describe, it, expect } from 'bun:test';
import { createDependencyGraph } from './dag.js';
import { CircularDependencyError } from '../errors.js';

// === Linear Chain ===

describe('Linear chain', () => {
  it('orders dependencies before dependents', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('c', ['y'], []);
    graph.addPlugin('b', ['x'], ['y']);
    graph.addPlugin('a', [], ['x']);

    const order = graph.getActivationOrder();
    expect(order).toContain('c');
    expect(order).toContain('b');
    expect(order).toContain('a');

    const indexC = order.indexOf('c');
    const indexB = order.indexOf('b');
    const indexA = order.indexOf('a');

    expect(indexC < indexB).toBe(true);
    expect(indexB < indexA).toBe(true);
  });

  it('correctly identifies dependents', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('c', ['y'], []);
    graph.addPlugin('b', ['x'], ['y']);
    graph.addPlugin('a', [], ['x']);

    const dependentsOfC = graph.getDependents('c');
    expect(dependentsOfC).toContain('b');
    expect(dependentsOfC).toContain('a');
    expect(dependentsOfC).toHaveLength(2);

    const dependentsOfB = graph.getDependents('b');
    expect(dependentsOfB).toContain('a');
    expect(dependentsOfB).toHaveLength(1);

    const dependentsOfA = graph.getDependents('a');
    expect(dependentsOfA).toHaveLength(0);
  });

  it('canActivate returns true for satisfied dependencies', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('c', ['y'], []);
    graph.addPlugin('b', ['x'], ['y']);
    graph.addPlugin('a', [], ['x']);

    expect(graph.canActivate('a')).toBe(true);
    expect(graph.canActivate('b')).toBe(true);
    expect(graph.canActivate('c')).toBe(true);
  });
});

// === Diamond Dependency ===

describe('Diamond dependency', () => {
  it('orders correctly with multiple paths to root', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['z'], []);
    graph.addPlugin('b', ['x'], ['z']);
    graph.addPlugin('c', ['y'], ['z']);
    graph.addPlugin('d', [], ['x', 'y']);

    const order = graph.getActivationOrder();
    const indexA = order.indexOf('a');
    const indexB = order.indexOf('b');
    const indexC = order.indexOf('c');
    const indexD = order.indexOf('d');

    expect(indexA < indexB).toBe(true);
    expect(indexA < indexC).toBe(true);
    expect(indexB < indexD).toBe(true);
    expect(indexC < indexD).toBe(true);
  });

  it('getDependents returns transitive dependents', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['z'], []);
    graph.addPlugin('b', ['x'], ['z']);
    graph.addPlugin('c', ['y'], ['z']);
    graph.addPlugin('d', [], ['x', 'y']);

    const dependentsOfA = graph.getDependents('a');
    expect(dependentsOfA).toContain('b');
    expect(dependentsOfA).toContain('c');
    expect(dependentsOfA).toContain('d');
  });

  it('getDependents returns sorted results (deterministic order)', () => {
    const graph = createDependencyGraph();
    // Register in reverse-alphabetical order to test deterministic sorting
    graph.addPlugin('provider', ['cap'], []);
    graph.addPlugin('zebra', [], ['cap']);
    graph.addPlugin('mango', [], ['cap']);
    graph.addPlugin('apple', [], ['cap']);

    const dependents = graph.getDependents('provider');
    // Should be alphabetically sorted despite registration order
    expect(dependents).toEqual(['apple', 'mango', 'zebra']);
  });
});

// === Independent Groups ===

describe('Independent groups', () => {
  it('respects relative ordering within groups', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('p1', ['a'], []);
    graph.addPlugin('p2', ['b'], ['a']);
    graph.addPlugin('p3', ['c'], []);
    graph.addPlugin('p4', ['d'], ['c']);

    const order = graph.getActivationOrder();
    expect(order.indexOf('p1') < order.indexOf('p2')).toBe(true);
    expect(order.indexOf('p3') < order.indexOf('p4')).toBe(true);
  });
});

// === Cycle Detection: Two-Node Cycle ===

describe('Two-node cycle detection', () => {
  it('detects cycle when second plugin closes a loop', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['y'], ['x']);

    expect(() => {
      graph.addPlugin('b', ['x'], ['y']);
    }).toThrow(CircularDependencyError);
  });

  it('preserves graph state after failed add', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['y'], ['x']);

    try {
      graph.addPlugin('b', ['x'], ['y']);
    } catch {
      // Expected to throw
    }

    // Graph should still contain only 'a'
    const order = graph.getActivationOrder();
    expect(order).toContain('a');
    expect(order).not.toContain('b');
  });

  it('cycle error message includes both plugins', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['y'], ['x']);

    let error: unknown;
    try {
      graph.addPlugin('b', ['x'], ['y']);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(CircularDependencyError);
    const message = (error as Error).message;
    expect(message).toContain('a');
    expect(message).toContain('b');
  });
});

// === Cycle Detection: Three-Node Cycle ===

describe('Three-node cycle detection', () => {
  it('detects three-node cycle: a→b→c→a', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], ['z']);
    graph.addPlugin('b', ['y'], ['x']);

    expect(() => {
      graph.addPlugin('c', ['z'], ['y']);
    }).toThrow(CircularDependencyError);
  });

  it('three-node cycle error includes all plugins', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], ['z']);
    graph.addPlugin('b', ['y'], ['x']);

    let error: unknown;
    try {
      graph.addPlugin('c', ['z'], ['y']);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(CircularDependencyError);
    const message = (error as Error).message;
    expect(message).toContain('a');
    expect(message).toContain('b');
    expect(message).toContain('c');
  });
});

// === Self-Loop ===

describe('Self-loop detection', () => {
  it('detects when plugin provides and needs the same capability', () => {
    const graph = createDependencyGraph();

    expect(() => {
      graph.addPlugin('a', ['x'], ['x']);
    }).toThrow(CircularDependencyError);
  });
});

// === Missing Dependency ===

describe('Missing dependency', () => {
  it('canActivate returns false for unsatisfied dependency', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', [], ['ghost-cap']);

    expect(graph.canActivate('a')).toBe(false);
  });

  it('checkDependencies marks unsatisfied capability', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', [], ['ghost-cap']);

    const checks = graph.checkDependencies('a');
    expect(checks).toHaveLength(1);
    expect(checks[0].capability).toBe('ghost-cap');
    expect(checks[0].satisfied).toBe(false);
    expect(checks[0].availableProviders).toHaveLength(0);
  });

  it('checkDependencies shows satisfied capabilities', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], []);
    graph.addPlugin('b', [], ['x']);

    const checks = graph.checkDependencies('b');
    expect(checks).toHaveLength(1);
    expect(checks[0].satisfied).toBe(true);
    expect(checks[0].availableProviders).toContain('a');
  });
});

// === Remove Plugin ===

describe('removePlugin', () => {
  it('removes plugin from activation order', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], []);
    graph.addPlugin('b', [], ['x']);

    graph.removePlugin('a');

    const order = graph.getActivationOrder();
    expect(order).not.toContain('a');
    expect(order).toContain('b');
  });

  it('affects canActivate after removal', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], []);
    graph.addPlugin('b', [], ['x']);

    expect(graph.canActivate('b')).toBe(true);
    graph.removePlugin('a');
    expect(graph.canActivate('b')).toBe(false);
  });

  it('getDependents returns empty after removal', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], []);
    graph.addPlugin('b', [], ['x']);

    expect(graph.getDependents('a')).toContain('b');
    graph.removePlugin('a');
    expect(graph.getDependents('a')).toHaveLength(0);
  });

  it('is idempotent — removing twice is safe', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], []);

    graph.removePlugin('a');
    expect(() => {
      graph.removePlugin('a');
    }).not.toThrow();
  });
});

// === Empty Graph ===

describe('Empty graph', () => {
  it('getActivationOrder returns empty array', () => {
    const graph = createDependencyGraph();
    const order = graph.getActivationOrder();
    expect(order).toHaveLength(0);
  });

  it('canActivate returns true for unknown plugin (vacuous truth)', () => {
    const graph = createDependencyGraph();
    expect(graph.canActivate('nonexistent')).toBe(true);
  });

  it('getDependents returns empty for unknown plugin', () => {
    const graph = createDependencyGraph();
    expect(graph.getDependents('nonexistent')).toHaveLength(0);
  });

  it('checkDependencies returns empty for unknown plugin', () => {
    const graph = createDependencyGraph();
    expect(graph.checkDependencies('nonexistent')).toHaveLength(0);
  });
});

// === Multiple Providers ===

describe('Multiple providers', () => {
  it('checkDependencies lists all providers', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('b', ['x'], []);
    graph.addPlugin('c', ['x'], []);
    graph.addPlugin('a', [], ['x']);

    const checks = graph.checkDependencies('a');
    expect(checks).toHaveLength(1);
    expect(checks[0].availableProviders).toContain('b');
    expect(checks[0].availableProviders).toContain('c');
  });

  it('canActivate returns true with multiple providers', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('b', ['x'], []);
    graph.addPlugin('c', ['x'], []);
    graph.addPlugin('a', [], ['x']);

    expect(graph.canActivate('a')).toBe(true);
  });
});

// === Idempotent addPlugin ===

describe('addPlugin idempotence', () => {
  it('adding the same plugin twice is a no-op', () => {
    const graph = createDependencyGraph();
    graph.addPlugin('a', ['x'], []);
    const order1 = graph.getActivationOrder();

    graph.addPlugin('a', ['y'], ['z']);
    const order2 = graph.getActivationOrder();

    expect(order1).toEqual(order2);
  });
});

// === Determinism ===

describe('getActivationOrder determinism', () => {
  it('independent plugins are ordered alphabetically (deterministic tie-breaking)', () => {
    const graph = createDependencyGraph();
    // Add two independent plugins in reverse-alphabetical order
    graph.addPlugin('zebra', [], []);
    graph.addPlugin('apple', [], []);
    graph.addPlugin('mango', [], []);

    const order = graph.getActivationOrder();

    // Despite registration order, topological sort should produce alphabetical order
    expect(order).toEqual(['apple', 'mango', 'zebra']);
  });

  it('mixed independent and dependent plugins maintain determinism', () => {
    const graph = createDependencyGraph();
    // Register in reverse order to test determinism
    // Note: graph tracks provides, not needs. zebra provides cap-x, mango needs cap-x
    graph.addPlugin('zebra', ['cap-x'], []);
    graph.addPlugin('mango', [], ['cap-x']);
    graph.addPlugin('apple', [], []);

    const order = graph.getActivationOrder();

    // Independent node (apple, zebra-no-deps) sorted first
    // Then mango which depends on cap-x (depends on zebra transitively)
    // Expected: apple and zebra are independent (sorted), then mango after its provider zebra
    expect(order[0]).toBe('apple');
    expect(order.indexOf('zebra')).toBeLessThan(order.indexOf('mango'));
  });
});
