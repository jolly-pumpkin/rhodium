import type { Broker, PluginContext, ErrorSeverity } from 'rhodium-core';

export interface MockPluginContext extends PluginContext {
  readonly emittedEvents: Array<{ event: string; payload: unknown }>;
  readonly reportedErrors: Array<{ error: Error; severity: string }>;
  readonly registeredTools: Map<string, unknown>;
  readonly registeredCommands: Map<string, unknown>;
  readonly providedCapabilities: Map<string, unknown>;
}

export interface TestBrokerResult {
  broker: Broker;
  mockContext: MockPluginContext;
}
