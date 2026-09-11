import { app, protocol, ipcMain } from 'electron';
import { ensureDirectoriesExist, appendToResultJson } from './utils/storage';
import { createChatSessionId } from './utils/helpers';
import {
  createWindows,
  getMainWindow,
  getWorkerWindow,
  getSelectedProvider,
  registerWindowControlListeners,
} from './windows';
import { registerNotesIpcHandlers } from './ipc/notes';
import { registerUpdaterHandlers } from './ipc/updater';
import { processAiPrompt } from './ai';
import { AIProvider, ChatSession } from './types';
import { getApiToken, startApiServer, stopApiServer } from './api';
import { configureNgrok, getNgrokSettings, startNgrok, stopNgrok } from './ngrok';
import { WebSocket } from 'ws';
import { readFileSync } from 'fs';
import { extname } from 'path';

const sessionState: {
  pendingChatUrl: string | null;
  activeChatSessionId: string | null;
  activeChatSession: ChatSession | null;
  isGeminiSessionInitialized: boolean;
  createChatSessionId: () => string;
} = {
  pendingChatUrl: null,
  activeChatSessionId: null,
  activeChatSession: null,
  isGeminiSessionInitialized: false,
  createChatSessionId,
};

function resetSessionState(): void {
  sessionState.activeChatSessionId = null;
  sessionState.activeChatSession = null;
  sessionState.isGeminiSessionInitialized = false;
}

ensureDirectoriesExist();

ipcMain.handle('get-api-token', () => getApiToken());
ipcMain.handle('get-ngrok-settings', () => getNgrokSettings());
ipcMain.handle('convert-local-image-to-base64', async (_event, filePath: string) => {
  try {
    const fileBuffer = readFileSync(filePath);
    const base64 = fileBuffer.toString('base64');
    const ext = extname(filePath).toLowerCase();
    let mimeType = 'image/png';
    
    if (ext === '.jpg' || ext === '.jpeg') {
      mimeType = 'image/jpeg';
    } else if (ext === '.gif') {
      mimeType = 'image/gif';
    } else if (ext === '.webp') {
      mimeType = 'image/webp';
    } else if (ext === '.svg') {
      mimeType = 'image/svg+xml';
    }
    
    return { success: true, base64, mimeType };
  } catch (error) {
    console.error('Error converting image to base64:', error);
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});
ipcMain.handle('configure-ngrok', async (_event, token: string, port: number, domain: string) => {
  try {
    await configureNgrok(token, port, domain);
    return { success: true, ...(await getNgrokSettings()) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
});

ipcMain.handle('sync-session-to-server', async (_event, serverUrl: string, password: string) => {
  const workerWindow = getWorkerWindow();
  if (!workerWindow || workerWindow.isDestroyed()) {
    return { success: false, error: 'Worker window is not available.' };
  }

  try {
    const ses = workerWindow.webContents.session;
    const cookies1 = await ses.cookies.get({ domain: 'chatgpt.com' });
    const cookies2 = await ses.cookies.get({ domain: '.chatgpt.com' });
    const cookieMap = new Map();
    for (const c of [...cookies1, ...cookies2]) {
      cookieMap.set(`${c.name}:${c.domain}:${c.path}`, c);
    }
    const cookies = Array.from(cookieMap.values());

    let localStorageData: Record<string, string> = {};
    try {
      const rawLs = await workerWindow.webContents.executeJavaScript('JSON.stringify(localStorage)');
      if (rawLs) localStorageData = JSON.parse(rawLs);
    } catch (_) {}

    const userAgent = workerWindow.webContents.getUserAgent();

    let targetWsUrl = (serverUrl || '').trim();
    if (!targetWsUrl.startsWith('ws://') && !targetWsUrl.startsWith('wss://')) {
      if (targetWsUrl.startsWith('http://')) targetWsUrl = targetWsUrl.replace(/^http:\/\//, 'ws://');
      else if (targetWsUrl.startsWith('https://')) targetWsUrl = targetWsUrl.replace(/^https:\/\//, 'wss://');
      else targetWsUrl = `wss://${targetWsUrl}`;
    }
    if (!targetWsUrl.endsWith('/ws/api')) {
      targetWsUrl = targetWsUrl.replace(/\/$/, '') + '/ws/api';
    }

    return await new Promise<{ success: boolean; loggedIn?: boolean; error?: string }>((resolve) => {
      const ws = new WebSocket(targetWsUrl);
      const timeout = setTimeout(() => {
        try { ws.close(); } catch (_) {}
        resolve({ success: false, error: 'Connection to server timed out.' });
      }, 20000);

      ws.on('open', () => {
        ws.send(JSON.stringify({
          type: 'sync_session',
          password,
          cookies,
          localStorage: localStorageData,
          userAgent,
        }));
      });

      ws.on('message', (raw) => {
        clearTimeout(timeout);
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'session_synced') {
            ws.close();
            resolve({ success: true, loggedIn: msg.loggedIn });
          } else if (msg.type === 'error') {
            ws.close();
            resolve({ success: false, error: msg.message || msg.code || 'Sync failed.' });
          }
        } catch (_) {
          ws.close();
          resolve({ success: false, error: 'Failed to parse response from server.' });
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        resolve({ success: false, error: err && err.message ? err.message : 'WebSocket error connecting to server.' });
      });
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
});

// --- AI Prompt Execution Handlers ---
ipcMain.handle('fill-chatgpt-input', async (_event, userText: string, attachments?: {
  base64: string;
  filename: string;
  mimeType: string;
  fileSize: number;
}[] | null) => {
  const workerWindow = getWorkerWindow();
  const mainWindow = getMainWindow();
  if (!workerWindow) return false;

  const provider = (await getSelectedProvider()) as AIProvider || 'chatgpt';

  try {
    const { resultPayload, newSessionId, newSession, newGeminiInitialized } = await processAiPrompt(
      workerWindow,
      mainWindow,
      userText,
      provider,
      sessionState.activeChatSessionId,
      sessionState.activeChatSession,
      sessionState.isGeminiSessionInitialized,
      attachments,
    );

    sessionState.activeChatSessionId = newSessionId;
    sessionState.activeChatSession = newSession;
    sessionState.isGeminiSessionInitialized = newGeminiInitialized;

    return resultPayload;
  } catch (err) {
    const error = err as Error;
    console.error('Failed to execute fluxnotes API script:', error);
    appendToResultJson({
      sessionId: sessionState.activeChatSessionId || null,
      error: error && error.message ? String(error.message) : String(error),
      errorStack: error && error.stack ? String(error.stack) : null,
    });
    return false;
  }
});

// --- Protocol & App Initialization ---
app.whenReady().then(async () => {
  try {
    if (await startApiServer()) await startNgrok();
  } catch (error) {
    console.error('[API/ngrok] Could not start:', error);
  }

  protocol.registerFileProtocol('local', (request, callback) => {
    const url = request.url.replace(/^local:\/\//, '');
    let decodedPath = decodeURI(url);
    if (process.platform === 'win32' && decodedPath.startsWith('/')) {
      decodedPath = decodedPath.slice(1);
    }
    callback({ path: decodedPath });
  });

  registerWindowControlListeners();
  registerNotesIpcHandlers(getMainWindow, getWorkerWindow, getSelectedProvider, sessionState);
  registerUpdaterHandlers(getMainWindow);

  createWindows(resetSessionState);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  void stopApiServer();
  void stopNgrok();
});