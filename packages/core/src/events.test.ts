import { describe, it, expect, beforeEach } from 'bun:test';
import { createEventBus } from './events.js';
import type { EventBus } from './events.js';

describe('createEventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = createEventBus();
  });

  it('on() + emit() delivers typed payload', () => {
    let received: { pluginKey: string; durationMs: number } | undefined;
    bus.on('plugin:activated', (payload) => {
      received = payload as { pluginKey: string; durationMs: number };
    });

    bus.emit('plugin:activated', { pluginKey: 'test', durationMs: 42 });
    expect(received).toEqual({ pluginKey: 'test', durationMs: 42 });
  });

  it('returned function unsubscribes handler', () => {
    let callCount = 0;
    const unsubscribe = bus.on('plugin:activated', () => {
      callCount++;
    });

    bus.emit('plugin:activated', { pluginKey: 'test', durationMs: 1 });
    expect(callCount).toBe(1);

    unsubscribe();
    bus.emit('plugin:activated', { pluginKey: 'test', durationMs: 2 });
    expect(callCount).toBe(1); // no change
  });

  it('multiple handlers for same event all called', () => {
    const calls: string[] = [];
    bus.on('plugin:activated', () => calls.push('a'));
    bus.on('plugin:activated', () => calls.push('b'));
    bus.on('plugin:activated', () => calls.push('c'));

    bus.emit('plugin:activated', { pluginKey: 'test', durationMs: 1 });
    expect(calls).toEqual(['a', 'b', 'c']);
  });

  it('handler that throws does not prevent other handlers from running', () => {
    const calls: string[] = [];
    bus.on('plugin:activated', () => {
      calls.push('a');
      throw new Error('boom');
    });
    bus.on('plugin:activated', () => calls.push('b'));

    bus.emit('plugin:activated', { pluginKey: 'test', durationMs: 1 });
    expect(calls).toEqual(['a', 'b']); // b was called despite a throwing
  });

  it('custom string event round-trips (non-BrokerEvent)', () => {
    let received: unknown;
    bus.on('custom:event', (payload) => {
      received = payload;
    });

    bus.emit('custom:event', { foo: 'bar' });
    expect(received).toEqual({ foo: 'bar' });
  });

  it('emit on unregistered event does nothing', () => {
    // Should not throw
    bus.emit('plugin:activated', { pluginKey: 'test', durationMs: 1 });
  });
});
