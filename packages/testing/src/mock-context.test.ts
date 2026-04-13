import { describe, it, expect } from 'bun:test';
import { CapabilityNotFoundError } from '../../core/src/errors.js';
import type { Plugin, CommandHandler } from '../../core/src/types.js';
import { createMockContext } from './mock-context.js';

describe('createMockContext — defaults', () => {
  it('defaults pluginKey to "test-plugin"', () => {
    const ctx = createMockContext();
    expect(ctx.pluginKey).toBe('test-plugin');
  });

  it('honors a custom pluginKey', () => {
    const ctx = createMockContext({ pluginKey: 'my-plugin' });
    expect(ctx.pluginKey).toBe('my-plugin');
  });

  it('exposes fresh recording collections on each call', () => {
    const a = createMockContext();
    const b = createMockContext();
    a.emittedEvents.push({ event: 'x', payload: 1 });
    expect(b.emittedEvents).toHaveLength(0);
    expect(a.emittedEvents).toHaveLength(1);
  });

  it('provides a silent logger by default (does not throw)', () => {
    const ctx = createMockContext();
    expect(() => {
      ctx.log.debug('d');
      ctx.log.info('i');
      ctx.log.warn('w');
      ctx.log.error('e');
    }).not.toThrow();
  });
});

describe('createMockContext — provide / resolve', () => {
  it('records provide() calls in providedCapabilities', () => {
    const ctx = createMockContext();
    const impl = { greet: () => 'hi' };
    ctx.provide('greeter', impl);
    expect(ctx.providedCapabilities.get('greeter')).toBe(impl);
  });

  it('resolve() returns provided implementations', () => {
    const ctx = createMockContext();
    const impl = { value: 42 };
    ctx.provide('thing', impl);
    expect(ctx.resolve<typeof impl>('thing')).toBe(impl);
  });

  it('resolve() returns preset resolutions', () => {
    const fakeLlm = { call: () => 'mock' };
    const ctx = createMockContext({ resolutions: { 'llm-provider': fakeLlm } });
    expect(ctx.resolve<typeof fakeLlm>('llm-provider')).toBe(fakeLlm);
  });

  it('resolve() throws CapabilityNotFoundError when unknown', () => {
    const ctx = createMockContext();
    expect(() => ctx.resolve('missing')).toThrow(CapabilityNotFoundError);
  });

  it('resolveOptional() returns undefined for unknown capabilities', () => {
    const ctx = createMockContext();
    expect(ctx.resolveOptional('missing')).toBeUndefined();
  });

  it('resolveOptional() returns preset and provided values', () => {
    const ctx = createMockContext({ resolutions: { a: 1 } });
    ctx.provide('b', 2);
    expect(ctx.resolveOptional<number>('a')).toBe(1);
    expect(ctx.resolveOptional<number>('b')).toBe(2);
    expect(ctx.resolveOptional('c')).toBeUndefined();
  });

  it('resolveAll() returns [] by default and preset arrays when configured', () => {
    const ctx = createMockContext({
      multipleResolutions: { middleware: [{ name: 'm1' }, { name: 'm2' }] },
    });
    expect(ctx.resolveAll('middleware')).toHaveLength(2);
    expect(ctx.resolveAll('unknown')).toEqual([]);
  });

  it('resolveAll() includes providedCapabilities alongside preset values', () => {
    const impl1 = { name: 'provided' };
    const impl2 = { name: 'preset1' };
    const impl3 = { name: 'preset2' };
    const ctx = createMockContext({
      multipleResolutions: { handlers: [impl2, impl3] },
    });
    ctx.provide('handlers', impl1);
    const result = ctx.resolveAll('handlers');
    expect(result).toHaveLength(3);
    expect(result[0]).toBe(impl1); // provided comes first
    expect(result).toContain(impl2); // preset values included
    expect(result).toContain(impl3);
  });
});

describe('createMockContext — command recording', () => {
  it('registerCommand() populates registeredCommands', () => {
    const ctx = createMockContext();
    const handler: CommandHandler = async () => {};
    ctx.registerCommand('run-cmd', handler);
    expect(ctx.registeredCommands.get('run-cmd')).toBe(handler);
  });
});

describe('createMockContext — emit + reportError', () => {
  it('emit() appends to emittedEvents preserving event and payload', () => {
    const ctx = createMockContext();
    ctx.emit('plugin:activated', { pluginKey: 'p', durationMs: 10 });
    expect(ctx.emittedEvents).toEqual([
      { event: 'plugin:activated', payload: { pluginKey: 'p', durationMs: 10 } },
    ]);
  });

  it('reportError() defaults severity to "error"', () => {
    const ctx = createMockContext();
    const err = new Error('boom');
    ctx.reportError(err);
    expect(ctx.reportedErrors).toEqual([{ error: err, severity: 'error' }]);
  });

  it('reportError() respects an explicit severity', () => {
    const ctx = createMockContext();
    const err = new Error('warn');
    ctx.reportError(err, 'warning');
    expect(ctx.reportedErrors[0]?.severity).toBe('warning');
  });
});

describe('createMockContext — end-to-end plugin isolation', () => {
  it('can unit-test a plugin by calling activate() with the mock context', () => {
    const plugin: Plugin = {
      key: 'greeter',
      version: '1.0.0',
      manifest: {
        name: 'Greeter',
        description: 'Greets people',
        provides: [{ capability: 'greet' }],
        needs: [],
      },
      activate(ctx) {
        ctx.provide('greet', (name: string) => `Hello, ${name}!`);
        ctx.emit('plugin:activated', { pluginKey: 'greeter', durationMs: 0 });
      },
    };

    const ctx = createMockContext({ pluginKey: 'greeter' });
    plugin.activate!(ctx);

    expect(ctx.providedCapabilities.has('greet')).toBe(true);
    const greet = ctx.providedCapabilities.get('greet') as (n: string) => string;
    expect(greet('world')).toBe('Hello, world!');
    expect(ctx.emittedEvents).toHaveLength(1);
    expect(ctx.emittedEvents[0]?.event).toBe('plugin:activated');
  });
});
