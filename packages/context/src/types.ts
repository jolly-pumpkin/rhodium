import type { ToolDeclaration, AssembledContext, ToolResult } from 'rhodium-core';

export interface ToolCall {
  pluginKey: string;
  toolName: string;
  params: Record<string, unknown>;
  callId: string;
}

export interface MiddlewarePlugin {
  preToolCall?(
    call: ToolCall
  ): Promise<ToolCall | null> | ToolCall | null;

  postToolCall?(
    call: ToolCall,
    result: ToolResult
  ): Promise<ToolResult> | ToolResult;

  postAssembly?(
    context: AssembledContext,
    tools: ToolDeclaration[]
  ): Promise<AssembledContext> | AssembledContext;
}
