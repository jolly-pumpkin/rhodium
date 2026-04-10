import { CapabilityNotFoundError } from 'rhodium-core';
import type { CapabilityDeclaration, DependencyDeclaration } from 'rhodium-core';
import type { CapabilityResolver, ProviderEntry } from './types.js';

export function createCapabilityResolver(): CapabilityResolver {
  // capability → list of provider entries
  const providers = new Map<string, ProviderEntry[]>();

  function getFiltered(capability: string, variant?: string): ProviderEntry[] {
    const all = providers.get(capability) ?? [];
    return variant === undefined ? all : all.filter(p => p.variant === variant);
  }

  function sortByPriorityThenRecency(entries: ProviderEntry[]): ProviderEntry[] {
    return [...entries].sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return b.registrationIndex - a.registrationIndex;
    });
  }

  return {
    registerProvider(pluginKey, declaration, registrationIndex) {
      const { capability, priority = 0, variant } = declaration;
      const entry: ProviderEntry = { pluginKey, capability, priority, variant, registrationIndex };
      const list = providers.get(capability) ?? [];
      list.push(entry);
      providers.set(capability, list);
    },

    unregisterPlugin(pluginKey) {
      for (const [cap, list] of providers) {
        const filtered = list.filter(p => p.pluginKey !== pluginKey);
        if (filtered.length === 0) {
          providers.delete(cap);
        } else {
          providers.set(cap, filtered);
        }
      }
    },

    resolve(dep, neededBy, neededByVersion) {
      const candidates = getFiltered(dep.capability, dep.variant);
      if (candidates.length === 0) {
        if (dep.optional) return undefined;
        // Pass all registered capability names so the error message is actionable
        const available = [...providers.keys()];
        throw new CapabilityNotFoundError(dep.capability, neededBy, neededByVersion, available);
      }
      return sortByPriorityThenRecency(candidates)[0];
    },

    resolveMany(dep, neededBy, neededByVersion) {
      const candidates = getFiltered(dep.capability, dep.variant);
      if (candidates.length === 0) {
        if (dep.optional) return [];
        const available = [...providers.keys()];
        throw new CapabilityNotFoundError(dep.capability, neededBy, neededByVersion, available);
      }
      return sortByPriorityThenRecency(candidates);
    },
  };
}
