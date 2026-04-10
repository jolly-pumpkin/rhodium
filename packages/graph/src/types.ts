import type { CapabilityDeclaration, DependencyDeclaration } from 'rhodium-core';

export interface DependencyCheck {
  pluginKey: string;
  capability: string;
  satisfied: boolean;
  availableProviders: string[];
}

export interface DependencyGraph {
  addPlugin(pluginKey: string, provides: string[], needs: string[]): void;
  removePlugin(pluginKey: string): void;
  /** Returns plugin keys in topological activation order */
  getActivationOrder(): string[];
  /** Returns true if all required dependencies for this plugin are satisfied */
  canActivate(pluginKey: string): boolean;
  /** Returns all plugins that (transitively) depend on this plugin */
  getDependents(pluginKey: string): string[];
  /** Returns unsatisfied dependency checks for a plugin */
  checkDependencies(pluginKey: string): DependencyCheck[];
}

export interface ProviderEntry {
  pluginKey: string;
  capability: string;
  priority: number;       // defaults to 0 if not set in CapabilityDeclaration
  variant: string | undefined;
  registrationIndex: number; // monotonically increasing; higher = more recently registered
}

export interface CapabilityResolver {
  /**
   * Register a plugin as a provider of a capability.
   * registrationIndex must be monotonically increasing (broker increments a counter).
   */
  registerProvider(pluginKey: string, declaration: CapabilityDeclaration, registrationIndex: number): void;
  /** Remove all provider entries for a plugin. */
  unregisterPlugin(pluginKey: string): void;
  /**
   * Resolve a single required or optional dependency.
   * - Returns the winning ProviderEntry, or undefined for optional+missing.
   * - Throws CapabilityNotFoundError for required+missing.
   */
  resolve(dep: DependencyDeclaration, neededBy: string, neededByVersion: string): ProviderEntry | undefined;
  /**
   * Resolve multiple providers (dep.multiple === true).
   * Always returns an array (empty if none found and dep.optional).
   */
  resolveMany(dep: DependencyDeclaration, neededBy: string, neededByVersion: string): ProviderEntry[];
}
