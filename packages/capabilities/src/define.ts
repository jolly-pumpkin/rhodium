import type { CapabilityContract, CapabilitySchema } from './types.js';

export function defineCapability<T>(
  name: string,
  schema?: CapabilitySchema
): CapabilityContract<T> {
  if (schema !== undefined) {
    return { name, schema, _type: undefined as unknown as T };
  }
  return { name, _type: undefined as unknown as T } as CapabilityContract<T>;
}
