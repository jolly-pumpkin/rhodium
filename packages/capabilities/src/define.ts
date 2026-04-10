import type { CapabilityContract, CapabilitySchema } from './types.js';

export function defineCapability<T>(
  name: string,
  schema?: CapabilitySchema
): CapabilityContract<T> {
  return { name, schema, _type: undefined as unknown as T };
}
