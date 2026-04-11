// ============================================================
// Rhodium typed error hierarchy
// ============================================================

export class RhodiumError extends Error {
  static readonly CODE = 'RHODIUM_ERROR';
  readonly code: string;
  readonly pluginKey?: string;
  readonly timestamp: number;

  constructor(message: string, code: string, pluginKey?: string) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.pluginKey = pluginKey;
    this.timestamp = Date.now();
    // Fix prototype chain for instanceof checks in transpiled ESM
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ============================================================
// Capability resolution errors
// ============================================================

export class CapabilityNotFoundError extends RhodiumError {
  static readonly CODE = 'CAPABILITY_NOT_FOUND';

  constructor(
    capability: string,
    neededBy: string,
    version: string,
    available: string[]
  ) {
    const availableList =
      available.length > 0
        ? available.map((c) => `    • ${c}`).join('\n')
        : '    (none)';

    const message = [
      `No provider for required capability '${capability}'`,
      '',
      `  Needed by: ${neededBy} (v${version})`,
      `  Declared as: required (not optional)`,
      '',
      `  Available capabilities in this broker:`,
      availableList,
      '',
      `  Did you forget to register a plugin that provides '${capability}'?`,
      `  If this dependency is not required, mark it as optional:`,
      `    needs: [{ capability: '${capability}', optional: true }]`,
    ].join('\n');

    super(message, CapabilityNotFoundError.CODE, neededBy);
  }
}

// ============================================================
// Dependency graph errors
// ============================================================

export class CircularDependencyError extends RhodiumError {
  static readonly CODE = 'CIRCULAR_DEPENDENCY';

  constructor(cycle: string[]) {
    const chain = cycle.map((plugin, i) => {
      const next = cycle[(i + 1) % cycle.length];
      const isLast = i === cycle.length - 1;
      return [
        `  ${plugin}`,
        `    → depends on ${next}${isLast ? '    ← cycle closes here' : ''}`,
      ].join('\n');
    });

    const message = [
      'Circular dependency detected',
      '',
      chain.join('\n'),
      '',
      `Plugins in cycle: ${cycle.join(', ')}`,
    ].join('\n');

    super(message, CircularDependencyError.CODE);
  }
}

// ============================================================
// Activation errors
// ============================================================

export class ActivationTimeoutError extends RhodiumError {
  static readonly CODE = 'ACTIVATION_TIMEOUT';

  constructor(pluginKey: string, timeoutMs: number) {
    super(
      `Plugin '${pluginKey}' activation timed out after ${timeoutMs}ms`,
      ActivationTimeoutError.CODE,
      pluginKey
    );
  }
}

export class ActivationError extends RhodiumError {
  static readonly CODE = 'ACTIVATION_FAILED';

  constructor(pluginKey: string, cause: Error) {
    super(
      `Plugin '${pluginKey}' activation failed: ${cause.message}`,
      ActivationError.CODE,
      pluginKey
    );
  }
}

// ============================================================
// Capability contract violation
// ============================================================

/** Mirrors CapabilityViolation from rhodium-capabilities (structurally compatible) */
export interface CapabilityViolation {
  kind: 'missing-method' | 'missing-property' | 'wrong-arity' | 'wrong-type';
  field: string;
  expected: string;
  actual: string;
}

export class CapabilityViolationError extends RhodiumError {
  static readonly CODE = 'CAPABILITY_VIOLATION';

  constructor(pluginKey: string, capability: string, violations: CapabilityViolation[]) {
    const sections: string[] = [];

    const missingMethods = violations.filter((v) => v.kind === 'missing-method');
    if (missingMethods.length > 0) {
      sections.push(
        '  Missing methods:\n' + missingMethods.map((v) => `    • ${v.field}`).join('\n')
      );
    }

    const missingProps = violations.filter((v) => v.kind === 'missing-property');
    if (missingProps.length > 0) {
      sections.push(
        '  Missing properties:\n' + missingProps.map((v) => `    • ${v.field}`).join('\n')
      );
    }

    const wrongArity = violations.filter((v) => v.kind === 'wrong-arity');
    if (wrongArity.length > 0) {
      sections.push(
        '  Wrong arity:\n' +
          wrongArity
            .map((v) => `    • ${v.field}: expected ${v.expected} parameters, got ${v.actual}`)
            .join('\n')
      );
    }

    const wrongTypes = violations.filter((v) => v.kind === 'wrong-type');
    if (wrongTypes.length > 0) {
      sections.push(
        '  Wrong types:\n' +
          wrongTypes.map((v) => `    • ${v.field}: expected ${v.expected}, got ${v.actual}`).join('\n')
      );
    }

    const message = [
      `Plugin '${pluginKey}' does not satisfy '${capability}' contract`,
      '',
      ...sections,
      '',
      `  Provided by: ${pluginKey}`,
      `  Contract: ${capability}`,
    ].join('\n');

    super(message, CapabilityViolationError.CODE, pluginKey);
  }
}

// ============================================================
// Manifest enforcement errors
// ============================================================

export class UndeclaredCapabilityError extends RhodiumError {
  static readonly CODE = 'UNDECLARED_CAPABILITY';

  constructor(pluginKey: string, capability: string) {
    super(
      `Plugin '${pluginKey}' called provide('${capability}') but '${capability}' is not declared in manifest.provides`,
      UndeclaredCapabilityError.CODE,
      pluginKey
    );
  }
}

export class UndeclaredToolError extends RhodiumError {
  static readonly CODE = 'UNDECLARED_TOOL';

  constructor(pluginKey: string, toolName: string) {
    super(
      `Plugin '${pluginKey}' called registerToolHandler('${toolName}') but '${toolName}' is not declared in manifest.tools`,
      UndeclaredToolError.CODE,
      pluginKey
    );
  }
}

// ============================================================
// Registration errors
// ============================================================

export class DuplicatePluginError extends RhodiumError {
  static readonly CODE = 'DUPLICATE_PLUGIN';

  constructor(pluginKey: string) {
    super(
      `Plugin '${pluginKey}' is already registered`,
      DuplicatePluginError.CODE,
      pluginKey
    );
  }
}

export class DuplicateToolError extends RhodiumError {
  static readonly CODE = 'DUPLICATE_TOOL';

  constructor(toolName: string, existingPluginKey: string, conflictingPluginKey: string) {
    super(
      `Tool name '${toolName}' is already registered\n\n  Existing:  ${existingPluginKey} declares '${toolName}'\n  Conflict:  ${conflictingPluginKey} also declares '${toolName}'`,
      DuplicateToolError.CODE
    );
  }
}

// ============================================================
// Runtime errors
// ============================================================

export class ToolExecutionError extends RhodiumError {
  static readonly CODE = 'TOOL_EXECUTION_FAILED';

  constructor(pluginKey: string, toolName: string, cause: Error) {
    super(
      `Tool '${toolName}' in plugin '${pluginKey}' failed: ${cause.message}`,
      ToolExecutionError.CODE,
      pluginKey
    );
  }
}

export class BudgetExceededError extends RhodiumError {
  static readonly CODE = 'BUDGET_EXCEEDED';

  constructor(pluginKey: string, requested: number, available: number) {
    super(
      `Plugin '${pluginKey}' requested ${requested} tokens but only ${available} are available`,
      BudgetExceededError.CODE,
      pluginKey
    );
  }
}

export class ContributionTooLargeError extends RhodiumError {
  static readonly CODE = 'CONTRIBUTION_TOO_LARGE';

  constructor(pluginKey: string, tokens: number, limit: number) {
    super(
      `Plugin '${pluginKey}' contribution of ${tokens} tokens exceeds the limit of ${limit}`,
      ContributionTooLargeError.CODE,
      pluginKey
    );
  }
}
