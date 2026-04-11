import type {
  Plugin,
  MiddlewarePlugin,
  ToolCall,
  ToolResult,
} from '../../core/src/types.js';

/** Capability name used by middleware-declaring plugins. */
export const MIDDLEWARE_CAPABILITY = 'middleware' as const;

/**
 * Extract and priority-sort plugins that declare the middleware capability.
 *
 * Plugins are sorted by `CapabilityDeclaration.priority` descending (undefined
 * priority is treated as 0). Ties are broken by registration order (stable
 * sort using the input array index).
 *
 * Plugins that declare the middleware capability but implement none of the
 * hooks are still returned — hook dispatchers use optional chaining, so empty
 * middleware is inert. This keeps `collectMiddleware` a pure filter+sort.
 *
 * The return type is `Plugin[]` (rather than `MiddlewarePlugin[]`) so callers
 * retain `plugin.key` for error reporting and tracing. Because `Plugin` has
 * the same optional hook fields, the result is structurally assignable to
 * `readonly MiddlewarePlugin[]` for dispatchers that only need the hooks.
 */
export function collectMiddleware(plugins: readonly Plugin[]): Plugin[] {
  const indexed: Array<{ plugin: Plugin; priority: number; index: number }> = [];
  for (let i = 0; i < plugins.length; i++) {
    const plugin = plugins[i]!;
    const decl = plugin.manifest.provides.find(
      (d) => d.capability === MIDDLEWARE_CAPABILITY,
    );
    if (!decl) continue;
    indexed.push({ plugin, priority: decl.priority ?? 0, index: i });
  }
  indexed.sort((a, b) => b.priority - a.priority || a.index - b.index);
  return indexed.map((x) => x.plugin);
}

/**
 * Execute a tool call through the middleware chain.
 *
 * Pre hooks run in array order (caller supplies high → low priority — use
 * `collectMiddleware` to sort). Each pre hook sees the result of the previous
 * hook. A pre hook may:
 *   - return a modified `ToolCall`  → continue chain with the new call
 *   - return `null`                  → skip handler; return
 *                                      `{ content: '', isError: false }`.
 *                                      No post hooks run.
 *   - return `ToolCall[]`            → fan out; each injected call walks the
 *                                      *remaining* (lower-priority) pre chain,
 *                                      handler, and full post chain
 *                                      independently.
 *
 * Post hooks run in reverse array order (low → high priority), wrapping the
 * handler onion-style. Each post hook sees the previous hook's output.
 *
 * Handler may be sync or async — `await handler(call)` handles both. Errors
 * from any hook or the handler propagate to the caller; `executeToolCall`
 * does not catch. Middleware hooks are invoked synchronously per the
 * `MiddlewarePlugin` contract.
 *
 * Return value: single call in → single `ToolResult` out. Fan-out in →
 * `ToolResult[]` (in order of final-call emission).
 */
export async function executeToolCall(
  call: ToolCall,
  handler: (c: ToolCall) => ToolResult | Promise<ToolResult>,
  middlewares: readonly MiddlewarePlugin[],
): Promise<ToolResult | ToolResult[]> {
  const results = await runFromIndex(call, 0);
  return results.length === 1 ? results[0]! : results;

  async function runFromIndex(
    current: ToolCall,
    startIdx: number,
  ): Promise<ToolResult[]> {
    let c: ToolCall = current;
    for (let i = startIdx; i < middlewares.length; i++) {
      const hook = middlewares[i]?.preToolCall;
      if (!hook) continue;
      const out = hook(c);
      if (out === null) {
        return [{ content: '', isError: false }];
      }
      if (Array.isArray(out)) {
        const branches: ToolResult[] = [];
        for (const branchCall of out) {
          branches.push(...(await runFromIndex(branchCall, i + 1)));
        }
        return branches;
      }
      c = out;
    }

    let result = await handler(c);

    for (let i = middlewares.length - 1; i >= 0; i--) {
      const hook = middlewares[i]?.postToolCall;
      if (!hook) continue;
      result = hook(c, result);
    }

    return [result];
  }
}
