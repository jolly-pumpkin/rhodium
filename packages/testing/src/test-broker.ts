// See mock-context.ts for the rationale on relative cross-package imports.
import { createBroker } from '../../core/src/broker.js';
import type { BrokerConfig, BrokerEvent } from '../../core/src/types.js';
import { createMockContext, type CreateMockContextOptions } from './mock-context.js';
import type { TestBrokerResult } from './types.js';

/**
 * Options for {@link createTestBroker}. Extends {@link BrokerConfig} with an
 * additional `mockContext` field forwarded to the bundled
 * {@link createMockContext} call.
 */
export interface CreateTestBrokerOptions extends BrokerConfig {
  /** Options forwarded to the bundled `createMockContext()`. */
  mockContext?: CreateMockContextOptions;
}

/**
 * Every broker event the test broker mirrors into `mockContext.emittedEvents`.
 * Declared locally (rather than imported) because `BROKER_EVENTS` in
 * `packages/core/src/broker.ts` is not exported. Keeping these in sync with
 * the `BrokerEvent` union is a compile-time concern: if a new event is added
 * to the union, TypeScript will flag this array as missing a member only if
 * it is asserted via `satisfies readonly BrokerEvent[]` — which we do below.
 */
const BROKER_EVENT_NAMES = [
  'plugin:registered',
  'plugin:unregistered',
  'plugin:activating',
  'plugin:activated',
  'plugin:deactivating',
  'plugin:deactivated',
  'plugin:error',
  'plugin:failed',
  'broker:activated',
  'broker:deactivated',
  'context:assembled',
  'budget:overflow',
  'capability:resolved',
  'tool:executed',
  'tool:error',
] as const satisfies readonly BrokerEvent[];

/**
 * Create a real {@link createBroker} instance pre-configured with
 * test-friendly defaults, paired with a standalone {@link createMockContext}
 * whose `emittedEvents` array mirrors every broker event. Use this for
 * integration tests where you want to register real plugins, activate them,
 * and assert on the events the broker emits end-to-end.
 *
 * Test defaults applied on top of any user-provided config:
 * - `activationTimeoutMs`: `1_000` (vs. production default `30_000`) — tests
 *   should fail fast rather than wait 30 seconds for a runaway `activate()`.
 * - `debug`: `false` — keeps test output quiet; override if you want broker
 *   events printed to the console.
 *
 * @example
 * ```ts
 * const { broker, mockContext } = createTestBroker();
 * broker.register(pluginA);
 * broker.register(pluginB);
 * await broker.activate();
 * expect(mockContext.emittedEvents.some(e => e.event === 'broker:activated')).toBe(true);
 * ```
 */
export function createTestBroker(
  options: CreateTestBrokerOptions = {}
): TestBrokerResult {
  const { mockContext: mockContextOptions, ...brokerConfig } = options;

  // Merge sensible test defaults without clobbering explicit overrides.
  const mergedConfig: BrokerConfig = {
    activationTimeoutMs: brokerConfig.activationTimeoutMs ?? 1_000,
    debug: brokerConfig.debug ?? false,
    ...(brokerConfig.tokenCounter !== undefined
      ? { tokenCounter: brokerConfig.tokenCounter }
      : {}),
    ...(brokerConfig.defaultTokenBudget !== undefined
      ? { defaultTokenBudget: brokerConfig.defaultTokenBudget }
      : {}),
    ...(brokerConfig.maxContributionBytes !== undefined
      ? { maxContributionBytes: brokerConfig.maxContributionBytes }
      : {}),
    ...(brokerConfig.lazyActivation !== undefined
      ? { lazyActivation: brokerConfig.lazyActivation }
      : {}),
    ...(brokerConfig.onUnhandledError !== undefined
      ? { onUnhandledError: brokerConfig.onUnhandledError }
      : {}),
  };

  const broker = createBroker(mergedConfig);
  const mockContext = createMockContext(mockContextOptions);

  // Mirror every broker event into the mock context so integration tests can
  // assert on the event stream via `mockContext.emittedEvents`.
  for (const event of BROKER_EVENT_NAMES) {
    broker.on(event, (payload: unknown) => {
      mockContext.emittedEvents.push({ event, payload });
    });
  }

  return { broker, mockContext };
}
