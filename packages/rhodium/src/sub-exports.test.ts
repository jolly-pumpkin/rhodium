import { describe, it, expect } from 'bun:test';
import * as localCore from './core.js';
import * as localCapabilities from './capabilities.js';
import * as localBudget from './budget.js';
import * as localDiscovery from './discovery.js';
import * as localGraph from './graph.js';
import * as localContext from './context.js';
import * as localTesting from './testing.js';

import * as rhodiumCore from 'rhodium-core';
import * as rhodiumCapabilities from 'rhodium-capabilities';
import * as rhodiumBudget from 'rhodium-budget';
import * as rhodiumDiscovery from 'rhodium-discovery';
import * as rhodiumGraph from 'rhodium-graph';
import * as rhodiumContext from 'rhodium-context';
import * as rhodiumTesting from 'rhodium-testing';

describe('rhodium sub-barrel packages', () => {
  it('rhodium/core mirrors the rhodium-core runtime surface', () => {
    const sub = Object.keys(localCore).sort();
    const src = Object.keys(rhodiumCore).sort();
    expect(sub).toEqual(src);
    expect(localCore.createBroker).toBe(rhodiumCore.createBroker);
  });

  it('rhodium/capabilities mirrors the rhodium-capabilities runtime surface', () => {
    const sub = Object.keys(localCapabilities).sort();
    const src = Object.keys(rhodiumCapabilities).sort();
    expect(sub).toEqual(src);
    expect(localCapabilities.defineCapability).toBe(rhodiumCapabilities.defineCapability);
    expect(localCapabilities.createCapabilityValidator).toBe(
      rhodiumCapabilities.createCapabilityValidator,
    );
  });

  it('rhodium/budget mirrors the rhodium-budget runtime surface', () => {
    const sub = Object.keys(localBudget).sort();
    const src = Object.keys(rhodiumBudget).sort();
    expect(sub).toEqual(src);
    expect(localBudget.createTokenCounter).toBe(rhodiumBudget.createTokenCounter);
    expect(localBudget.allocateBudget).toBe(rhodiumBudget.allocateBudget);
  });

  it('rhodium/discovery mirrors the rhodium-discovery runtime surface', () => {
    const sub = Object.keys(localDiscovery).sort();
    const src = Object.keys(rhodiumDiscovery).sort();
    expect(sub).toEqual(src);
    expect(localDiscovery.createSearchIndex).toBe(rhodiumDiscovery.createSearchIndex);
    expect(localDiscovery.searchTools).toBe(rhodiumDiscovery.searchTools);
  });

  it('rhodium/graph mirrors the rhodium-graph runtime surface', () => {
    const sub = Object.keys(localGraph).sort();
    const src = Object.keys(rhodiumGraph).sort();
    expect(sub).toEqual(src);
    expect(localGraph.createDependencyGraph).toBe(rhodiumGraph.createDependencyGraph);
    expect(localGraph.createCapabilityResolver).toBe(rhodiumGraph.createCapabilityResolver);
  });

  it('rhodium/context mirrors the rhodium-context runtime surface', () => {
    const sub = Object.keys(localContext).sort();
    const src = Object.keys(rhodiumContext).sort();
    expect(sub).toEqual(src);
    expect(localContext.createPipeline).toBe(rhodiumContext.createPipeline);
    expect(localContext.collectMiddleware).toBe(rhodiumContext.collectMiddleware);
    expect(localContext.executeToolCall).toBe(rhodiumContext.executeToolCall);
    expect(localContext.MIDDLEWARE_CAPABILITY).toBe(rhodiumContext.MIDDLEWARE_CAPABILITY);
  });

  it('rhodium/testing mirrors the rhodium-testing runtime surface', () => {
    const sub = Object.keys(localTesting).sort();
    const src = Object.keys(rhodiumTesting).sort();
    expect(sub).toEqual(src);
    expect(localTesting.createTestBroker).toBe(rhodiumTesting.createTestBroker);
    expect(localTesting.createMockContext).toBe(rhodiumTesting.createMockContext);
  });

  it('createBroker from rhodium/core is usable end-to-end', () => {
    const broker = localCore.createBroker();
    expect(broker).toBeDefined();
    expect(typeof broker.register).toBe('function');
    expect(typeof broker.activate).toBe('function');
    expect(typeof broker.assembleContext).toBe('function');
  });

  it('createTestBroker from rhodium/testing is usable end-to-end', () => {
    const { broker, mockContext } = localTesting.createTestBroker();
    expect(broker).toBeDefined();
    expect(mockContext).toBeDefined();
    expect(mockContext.pluginKey).toBe('test-plugin');
  });
});
