import { createBroker } from 'rhodium-core';
import type { BrokerConfig, BrokerEvent } from 'rhodium-core';
import { createMockContext, type CreateMockContextOptions } from './mock-context.js';
import type { TestBrokerResult } from './types.js';

export interface CreateTestBrokerOptions extends BrokerConfig {
  /** Options forwarded to the bundled `createMockContext()`. */
  mockContext?: CreateMockContextOptions;
}

const BROKER_EVENT_NAMES = [
  'plugin:registered',
  'plugin:unregistered',
  'plugin:activating',
  'plugin:activated',
  'plugin:deactivating',
  'plugin:deactivated',
  'plugin:error',
  'capability:provided',
  'capability:removed',
  'dependency:resolved',
  'dependency:unresolved',
  'broker:activated',
  'broker:deactivated',
] as const satisfies readonly BrokerEvent[];

export function createTestBroker(
  options: CreateTestBrokerOptions = {}
): TestBrokerResult {
  const { mockContext: mockContextOptions, ...brokerConfig } = options;

  const mergedConfig: BrokerConfig = {
    activationTimeoutMs: brokerConfig.activationTimeoutMs ?? 1_000,
    debug: brokerConfig.debug ?? false,
    ...(brokerConfig.onUnhandledError !== undefined
      ? { onUnhandledError: brokerConfig.onUnhandledError }
      : {}),
  };

  const broker = createBroker(mergedConfig);
  const mockContext = createMockContext(mockContextOptions);

  for (const event of BROKER_EVENT_NAMES) {
    broker.on(event, (payload: unknown) => {
      mockContext.emittedEvents.push({ event, payload });
    });
  }

  return { broker, mockContext };
}
