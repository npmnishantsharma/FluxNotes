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
import { configureNgrok, getNgrokSettings, startNgrok, stopNgrok } from './ngrok';
import { startApiServer, stopApiServer } from './api';

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

ipcMain.handle('get-ngrok-settings', () => getNgrokSettings());
ipcMain.handle('configure-ngrok', async (_event, token: string, port: number, domain: string) => {
  try {
    await configureNgrok(token, port, domain);
    return { success: true, ...(await getNgrokSettings()) };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
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
    await startApiServer();
    await startNgrok();
  } catch (error) {
    console.error('[ngrok] Could not start:', error);
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
