import { registerAbandonedWindowTools } from '../../src/tools/windows-abandoned';
import type { ToolHandler } from '../../src/types/mcp';

const listAbandonedWindows = jest.fn();
const claimAbandonedWindow = jest.fn();

jest.mock('../../src/session-manager', () => ({
  getSessionManager: () => ({ listAbandonedWindows, claimAbandonedWindow }),
}));

describe('abandoned window tools', () => {
  const handlers = new Map<string, ToolHandler>();

  beforeAll(() => {
    registerAbandonedWindowTools({
      registerTool: (name: string, handler: ToolHandler) => handlers.set(name, handler),
    } as any);
  });

  beforeEach(() => jest.clearAllMocks());

  test('lists only broker-provided abandoned windows', async () => {
    listAbandonedWindows.mockResolvedValue([{ id: 'abandoned-1', windowId: 7, tabs: [] }]);
    const result = await handlers.get('windows_abandoned')!('agent-a', {});
    expect(result.structuredContent).toEqual({
      count: 1,
      windows: [{ id: 'abandoned-1', windowId: 7, tabs: [] }],
    });
  });

  test('claims through the caller implicit session', async () => {
    claimAbandonedWindow.mockResolvedValue({ windowId: 7, tabIds: ['tab-1'] });
    const result = await handlers.get('window_claim')!('agent-a', { abandonedId: 'abandoned-1' });
    expect(claimAbandonedWindow).toHaveBeenCalledWith('agent-a', 'abandoned-1');
    expect(result.structuredContent).toMatchObject({ claimed: true, tabIds: ['tab-1'] });
  });
});
