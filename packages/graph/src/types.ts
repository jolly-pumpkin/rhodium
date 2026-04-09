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
