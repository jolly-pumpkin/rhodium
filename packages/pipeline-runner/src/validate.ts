import type { SchemaRef } from './spec.js';

export type ValidationResult =
  | { ok: true }
  | { ok: false; stageId: string; phase: string; errors: string[] };

export function validateStageData(
  stageId: string,
  phase: 'input' | 'output',
  schema: SchemaRef | undefined,
  data: unknown,
): ValidationResult {
  if (!schema) return { ok: true };
  const errors = schema.validate(data);
  if (errors.length === 0) return { ok: true };
  return { ok: false, stageId, phase, errors };
}
