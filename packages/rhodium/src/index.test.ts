import { describe, it, expect } from 'bun:test';
import * as rhodium from './index.js';
import * as rhodiumCore from 'rhodium-core';
import {
  createBroker,
  defineCapability,
  createCapabilityValidator,
  createTokenCounter,
  allocateBudget,
  createDependencyGraph,
  createCapabilityResolver,
  createSearchIndex,
  searchTools,
  createPipeline,
  executeToolCall,
  collectMiddleware,
  MIDDLEWARE_CAPABILITY,
  createTestBroker,
  createMockContext,
  assertContextIncludes,
  assertNoCriticalDrops,
  assertNoDropsAbovePriority,
  ContextAssertionError,
  RhodiumError,
  CapabilityNotFoundError,
  CircularDependencyError,
  DuplicatePluginError,
  DuplicateToolError,
  ActivationError,
  ActivationTimeoutError,
  CapabilityViolationError,
  UndeclaredCapabilityError,
  UndeclaredToolError,
  ToolExecutionError,
  BudgetExceededError,
  ContributionTooLargeError,
} from './index.js';
import type { Plugin } from './index.js';

describe('rhodium (main barrel)', () => {
  describe('runtime function/class exports', () => {
    it('re-exports the broker factory', () => {
      expect(typeof rhodium.createBroker).toBe('function');
      // Verify the barrel re-export is the same function as the source package.
      expect(rhodium.createBroker).toBe(rhodiumCore.createBroker);
    });

    it('re-exports capability helpers', () => {
      expect(typeof rhodium.defineCapability).toBe('function');
      expect(typeof rhodium.createCapabilityValidator).toBe('function');
    });

    it('re-exports budget helpers', () => {
      expect(typeof rhodium.createTokenCounter).toBe('function');
      expect(typeof rhodium.allocateBudget).toBe('function');
    });

    it('re-exports graph helpers', () => {
      expect(typeof rhodium.createDependencyGraph).toBe('function');
      expect(typeof rhodium.createCapabilityResolver).toBe('function');
    });

    it('re-exports discovery helpers', () => {
      expect(typeof rhodium.createSearchIndex).toBe('function');
      expect(typeof rhodium.searchTools).toBe('function');
    });

    it('re-exports context pipeline + middleware helpers', () => {
      expect(typeof rhodium.createPipeline).toBe('function');
      expect(typeof rhodium.executeToolCall).toBe('function');
      expect(typeof rhodium.collectMiddleware).toBe('function');
      expect(rhodium.MIDDLEWARE_CAPABILITY).toBe('middleware');
    });

    it('re-exports testing helpers', () => {
      expect(typeof rhodium.createTestBroker).toBe('function');
      expect(typeof rhodium.createMockContext).toBe('function');
      expect(typeof rhodium.assertContextIncludes).toBe('function');
      expect(typeof rhodium.assertNoCriticalDrops).toBe('function');
      expect(typeof rhodium.assertNoDropsAbovePriority).toBe('function');
      expect(typeof rhodium.ContextAssertionError).toBe('function');
    });

    it('re-exports the full error hierarchy with correct inheritance', () => {
      // Each concrete error must be a real class (not an accidental type-only re-export)
      // and must extend both RhodiumError and Error.
      const cause = new Error('boom');
      const instances: [string, InstanceType<typeof RhodiumError>][] = [
        ['CapabilityNotFoundError', new CapabilityNotFoundError('cap', 'p', '1.0', [])],
        ['CircularDependencyError', new CircularDependencyError(['a', 'b'])],
        ['DuplicatePluginError', new DuplicatePluginError('p')],
        ['DuplicateToolError', new DuplicateToolError('t', 'p1', 'p2')],
        ['ActivationError', new ActivationError('p', cause)],
        ['ActivationTimeoutError', new ActivationTimeoutError('p', 5000)],
        ['CapabilityViolationError', new CapabilityViolationError('p', 'cap', [])],
        ['UndeclaredCapabilityError', new UndeclaredCapabilityError('p', 'cap')],
        ['UndeclaredToolError', new UndeclaredToolError('p', 'tool')],
        ['ToolExecutionError', new ToolExecutionError('p', 'tool', cause)],
        ['BudgetExceededError', new BudgetExceededError('p', 100, 50)],
        ['ContributionTooLargeError', new ContributionTooLargeError('p', 200, 100)],
      ];
      for (const [name, err] of instances) {
        expect(err instanceof RhodiumError).toBe(true);
        expect(err instanceof Error).toBe(true);
        expect(err.code).toBeDefined();
        // Guard against accidental `export type` shadow losing class identity
        expect(typeof (rhodium as Record<string, unknown>)[name]).toBe('function');
      }
    });
  });

  // Type-export coverage lives in index.type-test.ts, verified by `tsc --noEmit`.
  // bun test strips `import type`, so runtime assertions on type-only imports
  // are false negatives — they pass even when the type is removed from the barrel.

  describe('integration — createBroker via the barrel', () => {
    it('registers a plugin, resolves a capability, and assembles context', async () => {
      const DatabaseContract = defineCapability<{ query(sql: string): Promise<unknown[]> }>(
        'database',
        { methods: { query: 1 } },
      );

      const providerPlugin: Plugin = {
        key: 'provider',
        version: '1.0.0',
        manifest: {
          provides: [{ capability: 'database' }],
          needs: [],
          tools: [
            {
              name: 'db-query',
              description: 'Execute a SQL query',
            },
          ],
        },
        activate(ctx) {
          ctx.provide('database', {
            query: async (_sql: string) => [],
          });
        },
        contributeContext() {
          return {
            pluginKey: 'provider',
            priority: 10,
            systemPromptFragment: 'Database capability available.',
          };
        },
      };

      const consumerPlugin: Plugin = {
        key: 'consumer',
        version: '1.0.0',
        manifest: {
          provides: [],
          needs: [{ capability: 'database' }],
          tools: [],
        },
      };

      const broker = createBroker({
        defaultTokenBudget: { maxTokens: 4096 },
      });
      broker.register(providerPlugin);
      broker.register(consumerPlugin);
      const result = await broker.activate();
      expect(result.activated).toContain('provider');
      expect(result.activated).toContain('consumer');

      const db = broker.resolve<{ query(sql: string): Promise<unknown[]> }>('database');
      expect(typeof db.query).toBe('function');

      // Validate the resolved provider against the capability contract schema.
      const validator = createCapabilityValidator();
      const violations = validator.validate(DatabaseContract, db);
      expect(violations).toEqual([]);

      const assembled = broker.assembleContext({
        tokenBudget: { maxTokens: 4096 },
      });
      expect(assembled.systemPrompt).toContain('Database capability available.');

      await broker.deactivate();
    });
  });
});
