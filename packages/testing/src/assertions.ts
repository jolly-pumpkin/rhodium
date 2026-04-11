// See mock-context.ts for the rationale on relative cross-package imports.
import type { AssembledContext } from '../../core/src/types.js';

/**
 * Thrown by all assertion helpers in this module when an expectation fails.
 *
 * Extends {@link Error} (not `node:assert.AssertionError` and not
 * `RhodiumError`) so that the helpers work in any JavaScript runtime and any
 * test framework without requiring a specific runner. Setting `name` to
 * `'ContextAssertionError'` is enough for bun/vitest/jest to surface the
 * throw as a test failure.
 *
 * The `details` field is a frozen record of structured failure data for
 * programmatic inspection — useful when meta-testing the assertions
 * themselves, or when wrapping them in higher-level helpers.
 */
export class ContextAssertionError extends Error {
  readonly details: Readonly<Record<string, unknown>>;

  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ContextAssertionError';
    this.details = Object.freeze({ ...details });
    // Fix prototype chain for `instanceof` checks in transpiled ESM.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Token utilization floor for {@link assertContextIncludes}. Exactly one arm
 * of this discriminated union must be supplied.
 *
 * - `{ ratio, maxTokens }` — require `totalTokens >= ceil(ratio * maxTokens)`.
 *   Use when your test knows the broker's token budget. `ratio` must be in
 *   `(0, 1]` and `maxTokens` must be `> 0`.
 * - `{ minTokens }` — require `totalTokens >= minTokens`. Use when you only
 *   care about an absolute floor. `minTokens` must be `>= 0`.
 *
 * `AssemblyMeta` does not currently carry the assembly budget, so the ratio
 * arm asks the caller to pass it explicitly rather than inferring it.
 */
export type MinTokenUtilization =
  | { ratio: number; maxTokens: number }
  | { minTokens: number };

/**
 * Options for {@link assertContextIncludes}. At least one field must be set;
 * an empty options object is a failure (it would silently pass, defeating
 * the assertion).
 */
export interface AssertContextIncludesOptions {
  /**
   * Plugin keys that must have contributed at least one tool to the
   * assembled context (matched against `context.tools[].pluginKey`).
   *
   * NOTE: `AssembledContext` does not attribute systemPrompt fragments to
   * their originating plugin, so a plugin that contributed only a prompt
   * fragment (no tools) will NOT be detected by this check. To guard against
   * such a plugin being dropped, use {@link assertNoCriticalDrops} instead.
   */
  plugins?: readonly string[];
  /** Tool names that must appear in `context.tools[].name`. */
  tools?: readonly string[];
  /** Minimum token utilization floor — see {@link MinTokenUtilization}. */
  minTokenUtilization?: MinTokenUtilization;
}

/**
 * Compute the required minimum token count implied by a
 * {@link MinTokenUtilization} option. Validates both arms and returns a
 * closure that renders a human-readable description of the required floor
 * for error messages.
 */
function computeUtilizationFloor(opt: MinTokenUtilization): {
  required: number;
  describe: () => string;
} {
  if ('ratio' in opt) {
    if (!Number.isFinite(opt.ratio) || opt.ratio <= 0 || opt.ratio > 1) {
      throw new ContextAssertionError(
        `assertContextIncludes: minTokenUtilization.ratio must be in (0, 1], got ${String(
          opt.ratio,
        )}`,
      );
    }
    if (!Number.isFinite(opt.maxTokens) || opt.maxTokens <= 0) {
      throw new ContextAssertionError(
        `assertContextIncludes: minTokenUtilization.maxTokens must be > 0, got ${String(
          opt.maxTokens,
        )}`,
      );
    }
    const required = Math.ceil(opt.ratio * opt.maxTokens);
    const pct = Math.round(opt.ratio * 100);
    return {
      required,
      describe: () => `${pct}% of ${opt.maxTokens} = ${required} tokens`,
    };
  }
  if (!Number.isFinite(opt.minTokens) || opt.minTokens < 0) {
    throw new ContextAssertionError(
      `assertContextIncludes: minTokenUtilization.minTokens must be >= 0, got ${String(
        opt.minTokens,
      )}`,
    );
  }
  return {
    required: opt.minTokens,
    describe: () => `${opt.minTokens} tokens (absolute floor)`,
  };
}

/**
 * Assert that an assembled context meets the given expectations. Throws
 * {@link ContextAssertionError} with a detailed multi-line diff listing every
 * failing expectation, so a single test can surface multiple problems at once.
 *
 * @example
 * assertContextIncludes(context, {
 *   plugins: ['auth', 'search'],
 *   tools: ['login', 'query'],
 *   minTokenUtilization: { ratio: 0.8, maxTokens: 4096 },
 * });
 */
export function assertContextIncludes(
  context: AssembledContext,
  options: AssertContextIncludesOptions,
): void {
  const { plugins, tools, minTokenUtilization } = options;

  // Empty options is a failure: silently passing an assertion with no
  // expectations defeats the whole point and hides typo'd option keys.
  if (
    plugins === undefined &&
    tools === undefined &&
    minTokenUtilization === undefined
  ) {
    throw new ContextAssertionError(
      'assertContextIncludes called with no expectations. ' +
        'Pass at least one of { plugins, tools, minTokenUtilization }.',
    );
  }

  const failures: string[] = [];
  const details: Record<string, unknown> = {};

  if (plugins !== undefined && plugins.length > 0) {
    const actualPlugins = new Set(context.tools.map((t) => t.pluginKey));
    const actualSorted = [...actualPlugins].sort();
    const missing = plugins.filter((p) => !actualPlugins.has(p));
    if (missing.length > 0) {
      failures.push(
        'Missing expected plugins (as tool contributors):',
        `    expected: [${[...plugins].join(', ')}]`,
        `    actual:   [${actualSorted.join(', ') || '(none)'}]`,
        `    missing:  [${missing.join(', ')}]`,
      );
      details['plugins'] = {
        expected: [...plugins],
        actual: actualSorted,
        missing,
      };
    }
  }

  if (tools !== undefined && tools.length > 0) {
    const actualTools = new Set(context.tools.map((t) => t.name));
    const actualSorted = [...actualTools].sort();
    const missing = tools.filter((t) => !actualTools.has(t));
    if (missing.length > 0) {
      failures.push(
        'Missing expected tools:',
        `    expected: [${[...tools].join(', ')}]`,
        `    actual:   [${actualSorted.join(', ') || '(none)'}]`,
        `    missing:  [${missing.join(', ')}]`,
      );
      details['tools'] = {
        expected: [...tools],
        actual: actualSorted,
        missing,
      };
    }
  }

  if (minTokenUtilization !== undefined) {
    const { required, describe } = computeUtilizationFloor(minTokenUtilization);
    if (context.totalTokens < required) {
      failures.push(
        'Token utilization below required floor:',
        `    required: ${describe()}`,
        `    actual:   ${context.totalTokens} tokens`,
        `    deficit:  ${required - context.totalTokens} tokens`,
      );
      details['utilization'] = {
        required,
        actual: context.totalTokens,
        deficit: required - context.totalTokens,
      };
    }
  }

  if (failures.length > 0) {
    throw new ContextAssertionError(
      ['assertContextIncludes failed:', '', ...failures].join('\n'),
      details,
    );
  }
}

/**
 * Shared implementation for both drop assertions. Collects drops whose
 * priority is strictly greater than `minPriority`, sorts them
 * deterministically, and throws a `ContextAssertionError` tagged with
 * `callerName` if any exist.
 */
function checkDrops(
  context: AssembledContext,
  minPriority: number,
  callerName: string,
): void {
  if (!Number.isFinite(minPriority)) {
    throw new ContextAssertionError(
      `${callerName}: minPriority must be a finite number, got ${String(
        minPriority,
      )}`,
    );
  }

  const offenders = context.dropped
    .filter((d) => d.priority > minPriority)
    .sort(
      (a, b) =>
        b.priority - a.priority || a.pluginKey.localeCompare(b.pluginKey),
    );

  if (offenders.length === 0) return;

  const header =
    callerName === 'assertNoCriticalDrops'
      ? `assertNoCriticalDrops failed: ${offenders.length} drop(s) above threshold`
      : `assertNoDropsAbovePriority(${minPriority}) failed: ${offenders.length} drop(s) above threshold`;

  const lines = [
    header,
    '',
    'Offending drops:',
    ...offenders.map(
      (d) =>
        `  • ${d.pluginKey} (priority=${d.priority}, severity=${d.severity}, reason=${d.reason}, estTokens=${d.estimatedTokens})`,
    ),
  ];

  throw new ContextAssertionError(lines.join('\n'), {
    minPriority,
    // Clone entries so callers can't mutate the assembled context via details.
    offenders: offenders.map((d) => ({ ...d })),
  });
}

/**
 * Assert that no contribution with priority `> 80` was dropped during
 * assembly. Priority 80 passes; 81 fails. Equivalent to
 * `assertNoDropsAbovePriority(context, 80)`.
 *
 * Throws {@link ContextAssertionError} listing every offending drop with its
 * plugin key, priority, severity, reason, and estimated token cost.
 */
export function assertNoCriticalDrops(context: AssembledContext): void {
  checkDrops(context, 80, 'assertNoCriticalDrops');
}

/**
 * Assert that no contribution with priority strictly greater than
 * `minPriority` was dropped during assembly. Drops at exactly `minPriority`
 * pass.
 *
 * Throws {@link ContextAssertionError} listing every offending drop, sorted
 * by priority descending (then pluginKey ascending for deterministic
 * message output).
 */
export function assertNoDropsAbovePriority(
  context: AssembledContext,
  minPriority: number,
): void {
  checkDrops(context, minPriority, 'assertNoDropsAbovePriority');
}
