export interface CapabilityViolation {
  kind: 'missing-method' | 'missing-property' | 'wrong-arity' | 'wrong-type';
  field: string;
  expected: string;
  actual: string;
}

export interface CapabilitySchema {
  /** Method name → expected parameter count (Function.length) */
  readonly methods?: Record<string, number>;
  /** Property names that must be defined (non-undefined) on the implementation */
  readonly properties?: readonly string[];
}

export interface CapabilityContract<T = unknown> {
  readonly name: string;
  readonly _type: T;
  readonly schema?: CapabilitySchema;
}

export interface CapabilityValidator {
  validate(
    contract: CapabilityContract,
    implementation: unknown
  ): CapabilityViolation[];
}
