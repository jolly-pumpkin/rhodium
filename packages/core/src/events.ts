import type { BrokerEvent, BrokerEventHandler, BrokerEventPayload } from './types.js';

export interface EventBus {
  on<E extends BrokerEvent>(event: E, handler: BrokerEventHandler<E>): () => void;
  on(event: string, handler: (payload: unknown) => void): () => void;
  emit<E extends BrokerEvent>(event: E, payload: BrokerEventPayload[E]): void;
  emit(event: string, payload: unknown): void;
}

export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();

  return {
    on(event: string, handler: (payload: unknown) => void): () => void {
      if (!handlers.has(event)) {
        handlers.set(event, new Set());
      }
      handlers.get(event)!.add(handler);
      return () => {
        handlers.get(event)!.delete(handler);
      };
    },

    emit(event: string, payload: unknown): void {
      const eventHandlers = handlers.get(event);
      if (!eventHandlers) return;
      for (const handler of eventHandlers) {
        try {
          handler(payload);
        } catch (err) {
          // Silently swallow handler errors to prevent event loop corruption
          // The broker's onUnhandledError is called only for plugin lifecycle errors
        }
      }
    },
  };
}
