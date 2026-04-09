export interface CapabilityViolation {
  kind: 'missing-method' | 'missing-property' | 'wrong-arity' | 'wrong-type';
  field: string;
  expected: string;
  actual: string;
}

export interface CapabilityContract<T = unknown> {
  readonly name: string;
  readonly _type: T;
}

export interface CapabilityValidator {
  validate(
    contract: CapabilityContract,
    implementation: unknown
  ): CapabilityViolation[];
}
