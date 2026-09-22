import { MCPServer } from '../mcp-server';
import { getSessionManager } from '../session-manager';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import type { MCPResult, MCPToolDefinition, ToolHandler } from '../types/mcp';

const listDefinition: MCPToolDefinition = {
  name: 'windows_abandoned',
  description: 'List abandoned agent-browser windows available for this agent to claim. Live windows owned by other agents are never shown.',
  annotations: TOOL_ANNOTATIONS.windows_abandoned,
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const claimDefinition: MCPToolDefinition = {
  name: 'window_claim',
  description: 'Atomically claim an abandoned agent-browser window and all of its tabs for the current agent session.',
  annotations: TOOL_ANNOTATIONS.window_claim,
  inputSchema: {
    type: 'object',
    properties: {
      abandonedId: { type: 'string', description: 'Abandoned window ID returned by windows_abandoned' },
    },
    required: ['abandonedId'],
  },
};

const listHandler: ToolHandler = async (): Promise<MCPResult> => {
  try {
    const windows = await getSessionManager().listAbandonedWindows();
    const structured = { count: windows.length, windows };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error listing abandoned windows: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

const claimHandler: ToolHandler = async (sessionId, args): Promise<MCPResult> => {
  try {
    const abandonedId = String(args.abandonedId ?? '');
    if (!abandonedId) throw new Error('abandonedId is required');
    const claimed = await getSessionManager().claimAbandonedWindow(sessionId, abandonedId);
    const structured = { claimed: true, abandonedId, ...claimed };
    return {
      content: [{ type: 'text', text: JSON.stringify(structured) }],
      structuredContent: structured as unknown as Record<string, unknown>,
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error claiming abandoned window: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
};

export function registerAbandonedWindowTools(server: MCPServer): void {
  server.registerTool('windows_abandoned', listHandler, listDefinition);
  server.registerTool('window_claim', claimHandler, claimDefinition);
}
