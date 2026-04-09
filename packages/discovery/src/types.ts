export interface ToolSearchFilter {
  /** Full-text query (natural language or keywords) */
  query?: string;
  /** Filter to tools provided by plugins with these capabilities */
  capability?: string;
  /** Filter to tools with ALL of these tags */
  tags?: string[];
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Minimum relevance score 0-1 (default: 0.1) */
  minRelevance?: number;
}

export interface ToolSearchResult {
  pluginKey: string;
  toolName: string;
  description: string;
  tags?: string[];
  relevanceScore: number;
  /** Whether the plugin is currently in 'active' state */
  isPluginActivated: boolean;
}
