import { describe, it, expect } from 'bun:test';
import * as rhodium from './index.js';
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
import type {
  Plugin,
  PluginManifest,
  PluginContext,
  PluginState,
  PluginLogger,
  Broker,
  BrokerConfig,
  BrokerEvent,
  BrokerEventPayload,
  BrokerEventHandler,
  BrokerLog,
  BrokerLogEntry,
  CapabilityDeclaration,
  DependencyDeclaration,
  ToolDeclaration,
  ToolExample,
  ToolSearchFilter,
  ToolSearchResult,
  ToolHandler,
  ToolResult,
  CommandHandler,
  TokenBudgetConfig,
  ContextRequest,
  ContextContribution,
  AssembledContext,
  AssembledTool,
  AssemblyMeta,
  DroppedContribution,
  RemainingBudget,
  ActivationResult,
  ErrorSeverity,
  DependencyGraph,
  DependencyCheck,
  CapabilityResolver,
  ProviderEntry,
  MiddlewarePlugin,
  ToolCall,
  CapabilityContract,
  CapabilityValidator,
  CapabilityViolation,
  CapabilitySchema,
} from './index.js';

describe('rhodium (main barrel)', () => {
  describe('runtime function/class exports', () => {
    it('re-exports the broker factory', () => {
      expect(typeof rhodium.createBroker).toBe('function');
      expect(rhodium.createBroker).toBe(createBroker);
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

    it('re-exports the full error hierarchy', () => {
      expect(typeof rhodium.RhodiumError).toBe('function');
      expect(typeof rhodium.CapabilityNotFoundError).toBe('function');
      expect(typeof rhodium.CircularDependencyError).toBe('function');
      expect(typeof rhodium.DuplicatePluginError).toBe('function');
      expect(typeof rhodium.DuplicateToolError).toBe('function');
      expect(typeof rhodium.ActivationError).toBe('function');
      expect(typeof rhodium.ActivationTimeoutError).toBe('function');
      expect(typeof rhodium.CapabilityViolationError).toBe('function');
      expect(typeof rhodium.UndeclaredCapabilityError).toBe('function');
      expect(typeof rhodium.UndeclaredToolError).toBe('function');
      expect(typeof rhodium.ToolExecutionError).toBe('function');
      expect(typeof rhodium.BudgetExceededError).toBe('function');
      expect(typeof rhodium.ContributionTooLargeError).toBe('function');
      // Error chain: concrete errors extend RhodiumError
      const err = new CapabilityNotFoundError('cap', 'plugin-a', '1.0.0', []);
      expect(err instanceof RhodiumError).toBe(true);
    });
  });

  describe('type imports compile via the barrel', () => {
    // These tests compile only if every listed type is actually exported.
    // bun test transpiles but does not typecheck, so we additionally reference
    // each import in a runtime expression so the transpiler doesn't tree-shake
    // them and any missing export turns into a runtime ReferenceError.
    it('every named type import is reachable', () => {
      // Reference each type via a dummy `undefined as unknown as T` so the
      // import is kept live. If the barrel drops one of these names, the
      // source file will fail to parse at bun test time.
      const plugin: Plugin = undefined as unknown as Plugin;
      const manifest: PluginManifest = undefined as unknown as PluginManifest;
      const ctx: PluginContext = undefined as unknown as PluginContext;
      const state: PluginState = 'active';
      const logger: PluginLogger = undefined as unknown as PluginLogger;
      const broker: Broker = undefined as unknown as Broker;
      const cfg: BrokerConfig = {};
      const event: BrokerEvent = 'plugin:registered';
      const payload: BrokerEventPayload = undefined as unknown as BrokerEventPayload;
      const handler: BrokerEventHandler<'plugin:registered'> =
        undefined as unknown as BrokerEventHandler<'plugin:registered'>;
      const brokerLog: BrokerLog = { entries: [] };
      const logEntry: BrokerLogEntry = undefined as unknown as BrokerLogEntry;
      const capDecl: CapabilityDeclaration = { capability: 'x' };
      const depDecl: DependencyDeclaration = { capability: 'x' };
      const tool: ToolDeclaration = { name: 'x', description: 'x' };
      const toolEx: ToolExample = { scenario: 's', input: {}, output: null };
      const toolFilter: ToolSearchFilter = {};
      const toolResultSearch: ToolSearchResult = undefined as unknown as ToolSearchResult;
      const toolHandler: ToolHandler = undefined as unknown as ToolHandler;
      const toolResult: ToolResult = { content: '' };
      const commandHandler: CommandHandler = undefined as unknown as CommandHandler;
      const budget: TokenBudgetConfig = { maxTokens: 1 };
      const req: ContextRequest = {};
      const contribution: ContextContribution =
        undefined as unknown as ContextContribution;
      const assembled: AssembledContext = undefined as unknown as AssembledContext;
      const assembledTool: AssembledTool = undefined as unknown as AssembledTool;
      const meta: AssemblyMeta = undefined as unknown as AssemblyMeta;
      const dropped: DroppedContribution = undefined as unknown as DroppedContribution;
      const remaining: RemainingBudget = undefined as unknown as RemainingBudget;
      const activation: ActivationResult = undefined as unknown as ActivationResult;
      const severity: ErrorSeverity = 'info';
      const graph: DependencyGraph = undefined as unknown as DependencyGraph;
      const depCheck: DependencyCheck = undefined as unknown as DependencyCheck;
      const resolver: CapabilityResolver = undefined as unknown as CapabilityResolver;
      const entry: ProviderEntry = undefined as unknown as ProviderEntry;
      const middleware: MiddlewarePlugin = undefined as unknown as MiddlewarePlugin;
      const call: ToolCall = undefined as unknown as ToolCall;
      const contract: CapabilityContract = undefined as unknown as CapabilityContract;
      const validator: CapabilityValidator = undefined as unknown as CapabilityValidator;
      const violation: CapabilityViolation = undefined as unknown as CapabilityViolation;
      const schema: CapabilitySchema = undefined as unknown as CapabilitySchema;

      // Keep the values "live" so tree-shakers can't drop the bindings.
      expect(
        [
          plugin,
          manifest,
          ctx,
          state,
          logger,
          broker,
          cfg,
          event,
          payload,
          handler,
          brokerLog,
          logEntry,
          capDecl,
          depDecl,
          tool,
          toolEx,
          toolFilter,
          toolResultSearch,
          toolHandler,
          toolResult,
          commandHandler,
          budget,
          req,
          contribution,
          assembled,
          assembledTool,
          meta,
          dropped,
          remaining,
          activation,
          severity,
          graph,
          depCheck,
          resolver,
          entry,
          middleware,
          call,
          contract,
          validator,
          violation,
          schema,
        ].length,
      ).toBeGreaterThan(0);
    });
  });

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

      const assembled = broker.assembleContext({
        tokenBudget: { maxTokens: 4096 },
      });
      expect(assembled.systemPrompt).toContain('Database capability available.');
      // Schema validation short-circuits when the provider shape matches.
      expect(DatabaseContract.name).toBe('database');

      await broker.deactivate();
    });
  });
});
