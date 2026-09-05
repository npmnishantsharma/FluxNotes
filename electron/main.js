"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const storage_1 = require("./utils/storage");
const helpers_1 = require("./utils/helpers");
const windows_1 = require("./windows");
const notes_1 = require("./ipc/notes");
const updater_1 = require("./ipc/updater");
const ai_1 = require("./ai");
const api_1 = require("./api");
const ngrok_1 = require("./ngrok");
const sessionState = {
    pendingChatUrl: null,
    activeChatSessionId: null,
    activeChatSession: null,
    isGeminiSessionInitialized: false,
    createChatSessionId: helpers_1.createChatSessionId,
};
function resetSessionState() {
    sessionState.activeChatSessionId = null;
    sessionState.activeChatSession = null;
    sessionState.isGeminiSessionInitialized = false;
}
(0, storage_1.ensureDirectoriesExist)();
electron_1.ipcMain.handle('get-api-token', () => (0, api_1.getApiToken)());
electron_1.ipcMain.handle('get-ngrok-settings', () => (0, ngrok_1.getNgrokSettings)());
electron_1.ipcMain.handle('configure-ngrok', async (_event, token, port, domain) => {
    try {
        await (0, ngrok_1.configureNgrok)(token, port, domain);
        return { success: true, ...(await (0, ngrok_1.getNgrokSettings)()) };
    }
    catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
});
// --- AI Prompt Execution Handlers ---
electron_1.ipcMain.handle('fill-chatgpt-input', async (_event, userText, attachments) => {
    const workerWindow = (0, windows_1.getWorkerWindow)();
    const mainWindow = (0, windows_1.getMainWindow)();
    if (!workerWindow)
        return false;
    const provider = (await (0, windows_1.getSelectedProvider)()) || 'chatgpt';
    try {
        const { resultPayload, newSessionId, newSession, newGeminiInitialized } = await (0, ai_1.processAiPrompt)(workerWindow, mainWindow, userText, provider, sessionState.activeChatSessionId, sessionState.activeChatSession, sessionState.isGeminiSessionInitialized, attachments);
        sessionState.activeChatSessionId = newSessionId;
        sessionState.activeChatSession = newSession;
        sessionState.isGeminiSessionInitialized = newGeminiInitialized;
        return resultPayload;
    }
    catch (err) {
        const error = err;
        console.error('Failed to execute fluxnotes API script:', error);
        (0, storage_1.appendToResultJson)({
            sessionId: sessionState.activeChatSessionId || null,
            error: error && error.message ? String(error.message) : String(error),
            errorStack: error && error.stack ? String(error.stack) : null,
        });
        return false;
    }
});
// --- Protocol & App Initialization ---
electron_1.app.whenReady().then(async () => {
    try {
        if (await (0, api_1.startApiServer)())
            await (0, ngrok_1.startNgrok)();
    }
    catch (error) {
        console.error('[API/ngrok] Could not start:', error);
    }
    electron_1.protocol.registerFileProtocol('local', (request, callback) => {
        const url = request.url.replace(/^local:\/\//, '');
        let decodedPath = decodeURI(url);
        if (process.platform === 'win32' && decodedPath.startsWith('/')) {
            decodedPath = decodedPath.slice(1);
        }
        callback({ path: decodedPath });
    });
    (0, windows_1.registerWindowControlListeners)();
    (0, notes_1.registerNotesIpcHandlers)(windows_1.getMainWindow, windows_1.getWorkerWindow, windows_1.getSelectedProvider, sessionState);
    (0, updater_1.registerUpdaterHandlers)(windows_1.getMainWindow);
    (0, windows_1.createWindows)(resetSessionState);
});
electron_1.app.on('window-all-closed', () => {
    if (process.platform !== 'darwin')
        electron_1.app.quit();
});
electron_1.app.on('before-quit', () => {
    void (0, api_1.stopApiServer)();
    void (0, ngrok_1.stopNgrok)();
});
