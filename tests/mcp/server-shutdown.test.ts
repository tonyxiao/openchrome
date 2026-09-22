/// <reference types="jest" />

jest.mock('../../src/cdp/client', () => ({
  getCDPClient: jest.fn(() => ({
    isConnected: jest.fn().mockReturnValue(false),
    disconnect: jest.fn().mockResolvedValue(undefined),
    forceReconnect: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/cdp/connection-pool', () => ({
  getCDPConnectionPool: jest.fn(() => ({ shutdown: jest.fn().mockResolvedValue(undefined) })),
}));

jest.mock('../../src/chrome/launcher', () => ({
  ChromeLauncher: jest.fn(),
  getChromeLauncher: jest.fn(() => ({
    isConnected: jest.fn().mockReturnValue(false),
    close: jest.fn().mockResolvedValue(undefined),
  })),
}));

const cleanupAllSessions = jest.fn().mockResolvedValue(0);
const sessionManager = {
  cleanupAllSessions,
  getSessions: jest.fn().mockReturnValue(new Map()),
  addEventListener: jest.fn(),
};

jest.mock('../../src/session-manager', () => ({
  getSessionManager: jest.fn(() => sessionManager),
}));

import { MCPServer } from '../../src/mcp-server';

describe('MCPServer shutdown robustness', () => {
  beforeEach(() => cleanupAllSessions.mockClear());

  test('concurrent stop calls share one cleanup', async () => {
    const server = new MCPServer(sessionManager as any);
    await Promise.all([server.stop(), server.stop()]);
    expect(cleanupAllSessions).toHaveBeenCalledTimes(1);
  });
});
