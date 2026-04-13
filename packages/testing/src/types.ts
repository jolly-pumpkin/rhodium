import type { Broker, PluginContext } from 'rhodium-core';

export interface MockPluginContext extends PluginContext {
  readonly emittedEvents: Array<{ event: string; payload: unknown }>;
  readonly reportedErrors: Array<{ error: Error; severity: string }>;
  readonly registeredCommands: Map<string, unknown>;
  readonly providedCapabilities: Map<string, unknown>;
}

export interface TestBrokerResult {
  broker: Broker;
  mockContext: MockPluginContext;
}
