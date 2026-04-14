/**
 * Pure cycle detection using DFS with 3-color marking.
 * Returns the first cycle found as an ordered array of node keys,
 * or null if the graph is acyclic.
 */
export function findCycle(adjacency: Map<string, Set<string>>): string[] | null {
  const white = new Set(adjacency.keys());
  const gray = new Set<string>();
  const black = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string): string[] | null {
    white.delete(node);
    gray.add(node);
    stack.push(node);

    const neighbors = adjacency.get(node) ?? new Set<string>();

    for (const neighbor of neighbors) {
      // Skip if already fully explored
      if (black.has(neighbor)) {
        continue;
      }

      // Back edge found — cycle detected
      if (gray.has(neighbor)) {
        const cycleStart = stack.indexOf(neighbor);
        return stack.slice(cycleStart);
      }

      // Recurse on unvisited neighbor
      const result = dfs(neighbor);
      if (result !== null) {
        return result;
      }
    }

    // Mark fully explored
    stack.pop();
    gray.delete(node);
    black.add(node);
    return null;
  }

  // Try DFS from each unvisited node
  while (white.size > 0) {
    const node = white.values().next().value!;
    const result = dfs(node);
    if (result !== null) {
      return result;
    }
  }

  return null;
}
