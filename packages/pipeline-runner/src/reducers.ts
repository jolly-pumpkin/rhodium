export interface FanoutResult {
  providerId: string;
  priority: number;
  output: unknown;
}

/** Collects all provider outputs into an array (preserving input order). */
export function concatReducer(results: FanoutResult[]): unknown[] {
  return results.map((r) => r.output);
}

/** Returns the output of the highest-priority provider. */
export function priorityPickReducer(results: FanoutResult[]): unknown {
  if (results.length === 0) return undefined;
  let best = results[0]!;
  for (let i = 1; i < results.length; i++) {
    if (results[i]!.priority > best.priority) best = results[i]!;
  }
  return best.output;
}
