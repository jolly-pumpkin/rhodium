import { describe, it, expect } from 'bun:test';
import {
  collectMiddleware,
  executeToolCall,
  MIDDLEWARE_CAPABILITY,
} from './middleware.js';
import type {
  Plugin,
  MiddlewarePlugin,
  ToolCall,
  ToolResult,
} from '../../core/src/types.js';

// ──────────────────────────────────────────────────────────────────────────
// Helpers (mirror packages/context/src/pipeline.test.ts style)
// ──────────────────────────────────────────────────────────────────────────

function makePlugin(overrides: Partial<Plugin> & { key: string }): Plugin {
  return {
    version: '1.0.0',
    manifest: { provides: [], needs: [], tools: [] },
    ...overrides,
  };
}

function makeMiddlewarePlugin(
  key: string,
  priority: number | undefined,
  hooks: Partial<Pick<Plugin, 'preToolCall' | 'postToolCall' | 'postAssembly'>>,
): Plugin {
  return makePlugin({
    key,
    manifest: {
      provides: [{ capability: MIDDLEWARE_CAPABILITY, priority }],
      needs: [],
      tools: [],
    },
    ...hooks,
  });
}

function makeCall(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    toolName: 'test',
    pluginKey: 'caller',
    parameters: {},
    timestamp: 0,
    ...overrides,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// collectMiddleware
// ──────────────────────────────────────────────────────────────────────────

describe('collectMiddleware', () => {
  it('returns empty array for empty plugin list', () => {
    expect(collectMiddleware([])).toEqual([]);
  });

  it('excludes plugins not declaring the middleware capability', () => {
    const p = makePlugin({
      key: 'a',
      manifest: { provides: [{ capability: 'other' }], needs: [], tools: [] },
    });
    expect(collectMiddleware([p])).toEqual([]);
  });

  it('includes a plugin declaring the middleware capability', () => {
    const p = makeMiddlewarePlugin('a', 10, {});
    const result = collectMiddleware([p]);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('a');
  });

  it('sorts by CapabilityDeclaration.priority descending', () => {
    const a = makeMiddlewarePlugin('a', 10, {});
    const b = makeMiddlewarePlugin('b', 50, {});
    const c = makeMiddlewarePlugin('c', 30, {});
    const result = collectMiddleware([a, b, c]);
    expect(result.map((p) => p.key)).toEqual(['b', 'c', 'a']);
  });

  it('treats missing priority as 0', () => {
    const a = makeMiddlewarePlugin('a', undefined, {});
    const b = makeMiddlewarePlugin('b', 5, {});
    const result = collectMiddleware([a, b]);
    expect(result.map((p) => p.key)).toEqual(['b', 'a']);
  });

  it('breaks ties by registration order (stable sort)', () => {
    const a = makeMiddlewarePlugin('a', 50, {});
    const b = makeMiddlewarePlugin('b', 50, {});
    const c = makeMiddlewarePlugin('c', 50, {});
    const result = collectMiddleware([a, b, c]);
    expect(result.map((p) => p.key)).toEqual(['a', 'b', 'c']);
  });

  it('includes plugins that declare the capability but implement no hooks', () => {
    const p = makeMiddlewarePlugin('a', 10, {}); // no hooks
    const result = collectMiddleware([p]);
    expect(result).toHaveLength(1);
    expect(result[0]?.key).toBe('a');
  });

  it('only considers the middleware capability, not other capabilities', () => {
    const p = makePlugin({
      key: 'a',
      manifest: {
        provides: [
          { capability: 'llm-provider', priority: 100 },
          { capability: MIDDLEWARE_CAPABILITY, priority: 10 },
        ],
        needs: [],
        tools: [],
      },
    });
    const other = makeMiddlewarePlugin('b', 50, {});
    const result = collectMiddleware([p, other]);
    expect(result.map((x) => x.key)).toEqual(['b', 'a']);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// executeToolCall — baseline
// ──────────────────────────────────────────────────────────────────────────

describe('executeToolCall — no middleware', () => {
  it('invokes handler and returns its result unchanged (sync)', async () => {
    const call = makeCall({ toolName: 'echo' });
    const handler = (c: ToolCall): ToolResult => ({
      content: `got:${c.toolName}`,
      isError: false,
    });
    const result = await executeToolCall(call, handler, []);
    expect(result).toEqual({ content: 'got:echo', isError: false });
  });

  it('awaits async handlers', async () => {
    const call = makeCall({ toolName: 'echo' });
    const handler = async (c: ToolCall): Promise<ToolResult> => {
      await Promise.resolve();
      return { content: `async:${c.toolName}`, isError: false };
    };
    const result = await executeToolCall(call, handler, []);
    expect(result).toEqual({ content: 'async:echo', isError: false });
  });
});

describe('executeToolCall — single middleware', () => {
  it('pre hook mutates parameters before handler runs', async () => {
    const call = makeCall({ parameters: { a: 1 } });
    const mw: MiddlewarePlugin = {
      preToolCall: (c) => ({ ...c, parameters: { ...c.parameters, injected: true } }),
    };
    let seen: ToolCall | null = null;
    const handler = (c: ToolCall): ToolResult => {
      seen = c;
      return { content: 'ok', isError: false };
    };
    await executeToolCall(call, handler, [mw]);
    expect(seen!.parameters).toEqual({ a: 1, injected: true });
  });

  it('pre hook returning null skips the handler and returns empty result', async () => {
    const call = makeCall();
    const mw: MiddlewarePlugin = { preToolCall: () => null };
    let handlerCalled = false;
    const handler = (): ToolResult => {
      handlerCalled = true;
      return { content: 'should-not-run', isError: false };
    };
    const result = await executeToolCall(call, handler, [mw]);
    expect(handlerCalled).toBe(false);
    expect(result).toEqual({ content: '', isError: false });
  });

  it('pre hook returning array fans out to multiple handler invocations', async () => {
    const call = makeCall({ toolName: 'orig' });
    const mw: MiddlewarePlugin = {
      preToolCall: (c) => [
        { ...c, toolName: 'a' },
        { ...c, toolName: 'b' },
      ],
    };
    const seen: string[] = [];
    const handler = (c: ToolCall): ToolResult => {
      seen.push(c.toolName);
      return { content: c.toolName, isError: false };
    };
    const result = await executeToolCall(call, handler, [mw]);
    expect(seen).toEqual(['a', 'b']);
    expect(Array.isArray(result)).toBe(true);
    expect((result as ToolResult[]).map((r) => r.content)).toEqual(['a', 'b']);
  });

  it('post hook transforms the handler result', async () => {
    const call = makeCall();
    const mw: MiddlewarePlugin = {
      postToolCall: (_c, r) => ({
        ...r,
        content: typeof r.content === 'string' ? r.content.toUpperCase() : r.content,
      }),
    };
    const handler = (): ToolResult => ({ content: 'hello', isError: false });
    const result = await executeToolCall(call, handler, [mw]);
    expect(result).toEqual({ content: 'HELLO', isError: false });
  });

  it('post hook can mark isError on a successful handler result', async () => {
    const call = makeCall();
    const mw: MiddlewarePlugin = {
      postToolCall: (_c, r) => ({ ...r, isError: true }),
    };
    const handler = (): ToolResult => ({ content: 'ok', isError: false });
    const result = await executeToolCall(call, handler, [mw]);
    expect(result).toEqual({ content: 'ok', isError: true });
  });
});

describe('executeToolCall — multi-middleware ordering', () => {
  it('pre hooks run in array order (caller-supplied high → low)', async () => {
    const log: string[] = [];
    const high: MiddlewarePlugin = {
      preToolCall: (c) => {
        log.push('pre:high');
        return c;
      },
    };
    const low: MiddlewarePlugin = {
      preToolCall: (c) => {
        log.push('pre:low');
        return c;
      },
    };
    await executeToolCall(makeCall(), () => ({ content: 'x', isError: false }), [
      high,
      low,
    ]);
    expect(log).toEqual(['pre:high', 'pre:low']);
  });

  it('post hooks run in reverse array order (low → high)', async () => {
    const log: string[] = [];
    const high: MiddlewarePlugin = {
      postToolCall: (_c, r) => {
        log.push('post:high');
        return r;
      },
    };
    const low: MiddlewarePlugin = {
      postToolCall: (_c, r) => {
        log.push('post:low');
        return r;
      },
    };
    await executeToolCall(makeCall(), () => ({ content: 'x', isError: false }), [
      high,
      low,
    ]);
    expect(log).toEqual(['post:low', 'post:high']);
  });

  it('full onion: pre(high) → pre(low) → handler → post(low) → post(high)', async () => {
    const log: string[] = [];
    const high: MiddlewarePlugin = {
      preToolCall: (c) => {
        log.push('pre:high');
        return c;
      },
      postToolCall: (_c, r) => {
        log.push('post:high');
        return r;
      },
    };
    const low: MiddlewarePlugin = {
      preToolCall: (c) => {
        log.push('pre:low');
        return c;
      },
      postToolCall: (_c, r) => {
        log.push('post:low');
        return r;
      },
    };
    const handler = (): ToolResult => {
      log.push('handler');
      return { content: 'x', isError: false };
    };
    await executeToolCall(makeCall(), handler, [high, low]);
    expect(log).toEqual(['pre:high', 'pre:low', 'handler', 'post:low', 'post:high']);
  });

  it('post hooks compose: each sees the prior hook transformed result', async () => {
    // Array order: [high, low]. Post runs low → high, so 'a' (low) appends
    // first, then 'b' (high) wraps on the outside.
    const high: MiddlewarePlugin = {
      postToolCall: (_c, r) => ({ ...r, content: `${r.content}:b` }),
    };
    const low: MiddlewarePlugin = {
      postToolCall: (_c, r) => ({ ...r, content: `${r.content}:a` }),
    };
    const handler = (): ToolResult => ({ content: 'x', isError: false });
    const result = await executeToolCall(makeCall(), handler, [high, low]);
    expect(result).toEqual({ content: 'x:a:b', isError: false });
  });

  it('injection fan-out walks remaining pre hooks + full post chain per result', async () => {
    // high pre injects two calls. low pre sees each injected call once and
    // annotates it. Handler echoes the marker. Both post hooks wrap the
    // individual results.
    const high: MiddlewarePlugin = {
      preToolCall: (c) => [
        { ...c, parameters: { mark: 'x' } },
        { ...c, parameters: { mark: 'y' } },
      ],
      postToolCall: (_c, r) => ({ ...r, content: `<${r.content}>` }),
    };
    const low: MiddlewarePlugin = {
      preToolCall: (c) => ({
        ...c,
        parameters: { ...c.parameters, mark: `${c.parameters.mark}!` },
      }),
      postToolCall: (_c, r) => ({ ...r, content: `[${r.content}]` }),
    };
    const handler = (c: ToolCall): ToolResult => ({
      content: String(c.parameters.mark),
      isError: false,
    });
    const result = await executeToolCall(makeCall(), handler, [high, low]);
    expect(Array.isArray(result)).toBe(true);
    // Each branch: handler sees mark `x!` / `y!`. Post chain runs low→high:
    // low wraps with [], high wraps with <>. Final: '<[x!]>' and '<[y!]>'.
    expect((result as ToolResult[]).map((r) => r.content)).toEqual([
      '<[x!]>',
      '<[y!]>',
    ]);
  });
});

describe('executeToolCall — error handling', () => {
  it('handler error propagates to caller', async () => {
    const handler = (): ToolResult => {
      throw new Error('handler boom');
    };
    await expect(executeToolCall(makeCall(), handler, [])).rejects.toThrow(
      'handler boom',
    );
  });

  it('pre hook error propagates', async () => {
    const mw: MiddlewarePlugin = {
      preToolCall: () => {
        throw new Error('pre boom');
      },
    };
    const handler = (): ToolResult => ({ content: 'x', isError: false });
    await expect(executeToolCall(makeCall(), handler, [mw])).rejects.toThrow(
      'pre boom',
    );
  });

  it('post hook error propagates', async () => {
    const mw: MiddlewarePlugin = {
      postToolCall: () => {
        throw new Error('post boom');
      },
    };
    const handler = (): ToolResult => ({ content: 'x', isError: false });
    await expect(executeToolCall(makeCall(), handler, [mw])).rejects.toThrow(
      'post boom',
    );
  });

  it('async preToolCall (returning a Promise) throws TypeError at runtime', async () => {
    // Defensive guard against an untyped plugin accidentally writing
    // `async preToolCall`. TypeScript catches this statically for declared
    // hook types, but the runtime check keeps the failure loud and obvious.
    const mw = {
      preToolCall: ((c: ToolCall) => Promise.resolve(c)) as unknown as
        MiddlewarePlugin['preToolCall'],
    } as MiddlewarePlugin;
    const handler = (): ToolResult => ({ content: 'x', isError: false });
    await expect(executeToolCall(makeCall(), handler, [mw])).rejects.toThrow(
      TypeError,
    );
    await expect(executeToolCall(makeCall(), handler, [mw])).rejects.toThrow(
      /preToolCall.*Promise/,
    );
  });

  it('async postToolCall (returning a Promise) throws TypeError at runtime', async () => {
    const mw = {
      postToolCall: ((_c: ToolCall, r: ToolResult) => Promise.resolve(r)) as unknown as
        MiddlewarePlugin['postToolCall'],
    } as MiddlewarePlugin;
    const handler = (): ToolResult => ({ content: 'x', isError: false });
    await expect(executeToolCall(makeCall(), handler, [mw])).rejects.toThrow(
      TypeError,
    );
    await expect(executeToolCall(makeCall(), handler, [mw])).rejects.toThrow(
      /postToolCall.*Promise/,
    );
  });
});

describe('executeToolCall — documented semantics', () => {
  it('post hook receives the handler-input call, not a per-middleware-local view', async () => {
    // Both middlewares mutate the call via preToolCall. The contract is
    // that every postToolCall in a branch sees the SAME call — the one
    // that was actually passed to the handler (after the full pre chain).
    const seenByPostHighPri: ToolCall[] = [];
    const seenByPostLowPri: ToolCall[] = [];
    const high: MiddlewarePlugin = {
      preToolCall: (c) => ({ ...c, parameters: { ...c.parameters, high: true } }),
      postToolCall: (c, r) => {
        seenByPostHighPri.push(c);
        return r;
      },
    };
    const low: MiddlewarePlugin = {
      preToolCall: (c) => ({ ...c, parameters: { ...c.parameters, low: true } }),
      postToolCall: (c, r) => {
        seenByPostLowPri.push(c);
        return r;
      },
    };
    const handler = (): ToolResult => ({ content: 'ok', isError: false });
    await executeToolCall(makeCall(), handler, [high, low]);
    // Both post hooks see the fully-mutated call (both `high: true` and
    // `low: true` present). Neither sees its own pre-hook's intermediate view.
    expect(seenByPostHighPri[0]?.parameters).toEqual({ high: true, low: true });
    expect(seenByPostLowPri[0]?.parameters).toEqual({ high: true, low: true });
  });

  it('null skip inside fan-out produces the empty sentinel for that branch only', async () => {
    // Documents the known ambiguity: callers cannot distinguish a null-skip
    // branch from a real empty-content success. Other branches still run
    // normally and produce their own results.
    const high: MiddlewarePlugin = {
      preToolCall: (c) => [
        { ...c, parameters: { branch: 'keep' } },
        { ...c, parameters: { branch: 'skip' } },
      ],
    };
    const low: MiddlewarePlugin = {
      preToolCall: (c) => (c.parameters.branch === 'skip' ? null : c),
    };
    const handler = (c: ToolCall): ToolResult => ({
      content: `handled:${c.parameters.branch}`,
      isError: false,
    });
    const result = await executeToolCall(makeCall(), handler, [high, low]);
    expect(Array.isArray(result)).toBe(true);
    const arr = result as ToolResult[];
    expect(arr).toHaveLength(2);
    expect(arr[0]).toEqual({ content: 'handled:keep', isError: false });
    expect(arr[1]).toEqual({ content: '', isError: false }); // skip sentinel
  });
});

describe('Plugin ↔ MiddlewarePlugin compatibility', () => {
  it('a Plugin implementing the hooks is structurally assignable to MiddlewarePlugin', () => {
    // Compile-time assertion: a plugin with the optional hook fields can be
    // passed directly to executeToolCall's middlewares parameter (typed as
    // readonly MiddlewarePlugin[]).
    const plugin: Plugin = makeMiddlewarePlugin('mw', 10, {
      preToolCall: (c) => c,
      postToolCall: (_c, r) => r,
      postAssembly: (ctx) => ctx,
    });
    const asMiddleware: MiddlewarePlugin = plugin;
    expect(asMiddleware.preToolCall).toBeDefined();
    expect(asMiddleware.postToolCall).toBeDefined();
    expect(asMiddleware.postAssembly).toBeDefined();
  });

  it('collectMiddleware output flows directly into executeToolCall', async () => {
    const plugin = makeMiddlewarePlugin('mw', 10, {
      preToolCall: (c) => ({ ...c, parameters: { ...c.parameters, stamped: true } }),
    });
    const mws = collectMiddleware([plugin]);
    let seen: ToolCall | null = null;
    const handler = (c: ToolCall): ToolResult => {
      seen = c;
      return { content: 'ok', isError: false };
    };
    await executeToolCall(makeCall(), handler, mws);
    expect(seen!.parameters.stamped).toBe(true);
  });
});
