import type { BrokerEvent, BrokerEventHandler } from './types.js';

export interface EventBus {
  on(event: BrokerEvent | string, handler: (payload: unknown) => void): () => void;
  emit(event: BrokerEvent | string, payload: unknown): void;
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
        } catch {
          // Silently swallow handler errors to prevent event loop corruption
        }
      }
    },
  };
}
