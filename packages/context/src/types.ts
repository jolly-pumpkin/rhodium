import type { ToolDeclaration, AssembledContext, ToolResult } from 'rhodium-core';

export interface ToolCall {
  toolName: string;
  pluginKey: string;
  parameters: Record<string, unknown>;
  timestamp: number;
}

export interface MiddlewarePlugin {
  preToolCall?(call: ToolCall): ToolCall | ToolCall[] | null;
  postToolCall?(call: ToolCall, result: ToolResult): ToolResult;
  postAssembly?(context: AssembledContext): AssembledContext;
}
