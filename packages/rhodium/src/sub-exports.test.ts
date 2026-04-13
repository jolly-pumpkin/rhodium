import { describe, it, expect } from 'bun:test';

import * as rhodiumCore from 'rhodium-core';
import * as rhodiumCapabilities from 'rhodium-capabilities';
import * as rhodiumGraph from 'rhodium-graph';
import * as rhodiumTesting from 'rhodium-testing';

/**
 * RHOD-020 acceptance criteria 2 & 3: `import { createBroker } from 'rhodium/core'`
 * and `import { createTestBroker } from 'rhodium/testing'` must work.
 *
 * These tests use `await import('rhodium/<sub>')` to exercise the actual package
 * subpath resolution chain: package.json `exports` -> `dist/<sub>.js` -> re-exports
 * from the underlying workspace package. This is NOT tautological -- it goes through
 * the exports map, unlike importing the source file `./core.js` directly.
 */
describe('rhodium sub-barrel packages (subpath exports)', () => {
  it('rhodium/core mirrors the rhodium-core runtime surface', async () => {
    const subpath = await import('rhodium/core');
    const sub = Object.keys(subpath).sort();
    const src = Object.keys(rhodiumCore).sort();
    expect(sub).toEqual(src);
    expect(subpath.createBroker).toBe(rhodiumCore.createBroker);
  });

  it('rhodium/capabilities mirrors the rhodium-capabilities runtime surface', async () => {
    const subpath = await import('rhodium/capabilities');
    const sub = Object.keys(subpath).sort();
    const src = Object.keys(rhodiumCapabilities).sort();
    expect(sub).toEqual(src);
    expect(subpath.defineCapability).toBe(rhodiumCapabilities.defineCapability);
    expect(subpath.createCapabilityValidator).toBe(
      rhodiumCapabilities.createCapabilityValidator,
    );
  });

  it('rhodium/graph mirrors the rhodium-graph runtime surface', async () => {
    const subpath = await import('rhodium/graph');
    const sub = Object.keys(subpath).sort();
    const src = Object.keys(rhodiumGraph).sort();
    expect(sub).toEqual(src);
    expect(subpath.createDependencyGraph).toBe(rhodiumGraph.createDependencyGraph);
    expect(subpath.createCapabilityResolver).toBe(rhodiumGraph.createCapabilityResolver);
  });

  it('rhodium/testing mirrors the rhodium-testing runtime surface', async () => {
    const subpath = await import('rhodium/testing');
    const sub = Object.keys(subpath).sort();
    const src = Object.keys(rhodiumTesting).sort();
    expect(sub).toEqual(src);
    expect(subpath.createTestBroker).toBe(rhodiumTesting.createTestBroker);
    expect(subpath.createMockContext).toBe(rhodiumTesting.createMockContext);
  });
});
