import { CircularDependencyError } from 'rhodium-core';
import { DependencyGraph, DependencyCheck } from './types.js';
import { findCycle } from './cycle-detect.js';

/**
 * Factory function that creates a dependency graph.
 * Manages plugins, their capabilities, and tracks activation order.
 */
export function createDependencyGraph(): DependencyGraph {
  // Capabilities provided by each plugin
  const pluginProvides = new Map<string, Set<string>>();

  // Capabilities needed by each plugin
  const pluginNeeds = new Map<string, Set<string>>();

  // Plugins that provide each capability
  const capabilityProviders = new Map<string, Set<string>>();

  /**
   * Build adjacency list from current state.
   * Edge A→B means "A depends on B".
   *
   * INVARIANT: Every plugin must be in pluginProvides (enforced by addPlugin atomicity).
   * This ensures all registered plugins appear as nodes in the adjacency list.
   */
  function buildAdjacency(): Map<string, Set<string>> {
    const adjacency = new Map<string, Set<string>>();

    for (const pluginKey of pluginProvides.keys()) {
      adjacency.set(pluginKey, new Set<string>());
    }

    for (const [pluginKey, needs] of pluginNeeds) {
      const neighbors = adjacency.get(pluginKey)!;

      for (const capability of needs) {
        const providers = capabilityProviders.get(capability) ?? new Set<string>();
        for (const provider of providers) {
          neighbors.add(provider);
        }
      }
    }

    return adjacency;
  }

  /**
   * Rollback mutations if cycle is detected.
   */
  function rollbackPlugin(pluginKey: string, provides: string[], needs: string[]): void {
    pluginProvides.delete(pluginKey);
    pluginNeeds.delete(pluginKey);

    for (const capability of provides) {
      const providers = capabilityProviders.get(capability);
      if (providers) {
        providers.delete(pluginKey);
        if (providers.size === 0) {
          capabilityProviders.delete(capability);
        }
      }
    }
  }

  return {
    addPlugin(pluginKey: string, provides: string[], needs: string[]): void {
      // Guard: idempotent — return if already registered
      if (pluginProvides.has(pluginKey)) {
        return;
      }

      // Register provided capabilities
      pluginProvides.set(pluginKey, new Set(provides));
      for (const capability of provides) {
        if (!capabilityProviders.has(capability)) {
          capabilityProviders.set(capability, new Set<string>());
        }
        capabilityProviders.get(capability)!.add(pluginKey);
      }

      // Register needed capabilities
      pluginNeeds.set(pluginKey, new Set(needs));

      // Check for cycles
      const adjacency = buildAdjacency();
      const cycle = findCycle(adjacency);

      if (cycle !== null) {
        rollbackPlugin(pluginKey, provides, needs);
        throw new CircularDependencyError(cycle);
      }
    },

    removePlugin(pluginKey: string): void {
      if (!pluginProvides.has(pluginKey)) {
        return;
      }

      // Remove from provides
      const provides = pluginProvides.get(pluginKey)!;
      for (const capability of provides) {
        const providers = capabilityProviders.get(capability)!;
        providers.delete(pluginKey);
        if (providers.size === 0) {
          capabilityProviders.delete(capability);
        }
      }
      pluginProvides.delete(pluginKey);

      // Remove from needs
      pluginNeeds.delete(pluginKey);
    },

    getActivationOrder(): string[] {
      const adjacency = buildAdjacency();

      // Build reverse adjacency for Kahn's algorithm
      // Forward: A→B (A depends on B)
      // Reverse: B→A (means A depends on B)
      const reverseAdj = new Map<string, Set<string>>();
      const inDegree = new Map<string, number>();

      // Initialize
      for (const pluginKey of pluginProvides.keys()) {
        reverseAdj.set(pluginKey, new Set<string>());
        inDegree.set(pluginKey, 0);
      }

      // Build reverse adjacency
      for (const [pluginKey, neighbors] of adjacency) {
        for (const neighbor of neighbors) {
          reverseAdj.get(neighbor)!.add(pluginKey);
        }
      }

      // Calculate inDegree on the reverse adjacency
      for (const [node, neighbors] of reverseAdj) {
        for (const neighbor of neighbors) {
          inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) + 1);
        }
      }

      // Kahn's algorithm
      const queue: string[] = [];
      for (const [pluginKey, degree] of inDegree) {
        if (degree === 0) {
          queue.push(pluginKey);
        }
      }

      const result: string[] = [];
      while (queue.length > 0) {
        const node = queue.shift()!;
        result.push(node);

        const neighbors = reverseAdj.get(node)!;
        for (const neighbor of neighbors) {
          inDegree.set(neighbor, (inDegree.get(neighbor) ?? 0) - 1);
          if (inDegree.get(neighbor) === 0) {
            queue.push(neighbor);
          }
        }
      }

      return result;
    },

    canActivate(pluginKey: string): boolean {
      const needs = pluginNeeds.get(pluginKey);
      if (!needs || needs.size === 0) {
        return true;
      }

      for (const capability of needs) {
        const providers = capabilityProviders.get(capability);
        if (!providers || providers.size === 0) {
          return false;
        }
      }

      return true;
    },

    getDependents(pluginKey: string): string[] {
      const adjacency = buildAdjacency();

      // Build reverse adjacency: B→A edges mean "A depends on B"
      const reverseAdj = new Map<string, Set<string>>();
      for (const key of pluginProvides.keys()) {
        reverseAdj.set(key, new Set<string>());
      }

      for (const [plugin, neighbors] of adjacency) {
        for (const neighbor of neighbors) {
          reverseAdj.get(neighbor)!.add(plugin);
        }
      }

      // BFS from pluginKey in reverse adjacency
      const visited = new Set<string>();
      const queue: string[] = [pluginKey];

      while (queue.length > 0) {
        const node = queue.shift()!;

        const dependents = reverseAdj.get(node) ?? new Set<string>();
        for (const dependent of dependents) {
          if (!visited.has(dependent)) {
            visited.add(dependent);
            queue.push(dependent);
          }
        }
      }

      return Array.from(visited);
    },

    checkDependencies(pluginKey: string): DependencyCheck[] {
      const needs = pluginNeeds.get(pluginKey) ?? new Set<string>();
      const result: DependencyCheck[] = [];

      for (const capability of needs) {
        const providers = capabilityProviders.get(capability);
        const availableProviders = Array.from(providers ?? []);

        result.push({
          pluginKey,
          capability,
          satisfied: availableProviders.length > 0,
          availableProviders,
        });
      }

      return result;
    },
  };
}
