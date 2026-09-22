/**
 * Tabs Create Tool - Create a new tab in the session with a specific URL
 *
 * Tabs use the shared persistent profile unless the caller explicitly asks
 * for an in-process incognito context.
 */

import { MCPServer } from '../mcp-server';
import { MCPToolDefinition, MCPResult, ToolHandler } from '../types/mcp';
import { TOOL_ANNOTATIONS } from '../types/tool-annotations';
import { getSessionManager } from '../session-manager';
import { safeTitle } from '../core/page/safe-title';
import { assertDomainAllowed, DomainPolicyError } from '../security/domain-guard';
import { wrapMutatingHandler } from '../core/perception/snapshot-cache-helper';
import { autoRecallForUrl } from '../core/skill-memory/auto-recall';

const definition: MCPToolDefinition = {
  name: 'tabs_create',
  description: 'Create a new tab with URL.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to open in the new tab',
      },
      workerId: {
        type: 'string',
        description: 'Worker ID for parallel ops. Default: default',
      },
      recall: {
        type: 'boolean',
        description: 'Override OPENCHROME_AUTO_RECALL for this call. true forces domain skill injection; false suppresses it even when the flag is on.',
      },
      incognito: {
        type: 'boolean',
        description: 'Open in this agent session\'s disposable incognito BrowserContext. It uses the same Chrome process but does not share profile storage; all such tabs are discarded when the agent session ends.',
      },
    },
    required: ['url'],
  },
  annotations: TOOL_ANNOTATIONS.tabs_create,
};

const handler: ToolHandler = async (
  sessionId: string,
  args: Record<string, unknown>
): Promise<MCPResult> => {
  const sessionManager = getSessionManager();
  const url = args.url as string;
  const recallArg = args.recall as boolean | undefined;
  const incognito = args.incognito === true;
  if (incognito && args.workerId) {
    return {
      content: [{ type: 'text', text: 'Error: incognito cannot be combined with workerId.' }],
      isError: true,
    };
  }
  const workerId = incognito
    ? `incognito:${sessionId}`
    : (args.workerId as string | undefined);

  // URL is required
  if (!url) {
    return {
      content: [
        {
          type: 'text',
          text: 'Error: url is required. Use navigate tool without tabId to create a new tab with a URL.',
        },
      ],
      isError: true,
    };
  }

  // Domain policy check before creating the tab
  try {
    assertDomainAllowed(url);
  } catch (error) {
    if (error instanceof DomainPolicyError) {
      return {
        content: [{ type: 'text', text: JSON.stringify(error.blocked) }],
        structuredContent: error.blocked as unknown as Record<string, unknown>,
        isError: true,
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const result = await sessionManager.createTarget(
      sessionId,
      url,
      workerId,
      incognito,
    );
    const { targetId, page, workerId: assignedWorkerId, contextName, isolated } = result;

    const finalUrl = page.url();
    const domainSkills = await autoRecallForUrl(finalUrl, recallArg);
    const payload: Record<string, unknown> = {
      tabId: targetId,
      workerId: assignedWorkerId,
      url: finalUrl,
      title: await safeTitle(page),
      context: { name: contextName, isolated },
    };
    if (domainSkills !== undefined) {
      payload.domain_skills = domainSkills;
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Error creating tab: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
};

export function registerTabsCreateTool(server: MCPServer): void {
  // Snapshot-cache (#879): bump docEpoch defensively so a read against a
  // newly-created tab cannot inherit a stale entry from a recycled
  // target id.
  const wrapped = wrapMutatingHandler(handler, (sid, tid) =>
    tid ? getSessionManager().getPage(sid, tid, undefined, 'tabs_create') : Promise.resolve(null),
  );
  server.registerTool('tabs_create', wrapped, definition);
}
