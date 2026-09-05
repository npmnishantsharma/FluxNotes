"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.GEMINI_SIGN_IN_URL = exports.CHATGPT_URL = exports.PROVIDER_STORAGE_KEY = exports.forceAllowDevTools = exports.forceShowWorker = void 0;
exports.getMainWindow = getMainWindow;
exports.getWorkerWindow = getWorkerWindow;
exports.disableDevTools = disableDevTools;
exports.openAppLinksExternally = openAppLinksExternally;
exports.isChatGptUrl = isChatGptUrl;
exports.isGeminiUrl = isGeminiUrl;
exports.getSelectedProvider = getSelectedProvider;
exports.isAuthProviderUrl = isAuthProviderUrl;
exports.startLoginCheckRoutine = startLoginCheckRoutine;
exports.registerWindowControlListeners = registerWindowControlListeners;
exports.createWindows = createWindows;
const electron_1 = require("electron");
const electron_serve_1 = __importDefault(require("electron-serve"));
const path_1 = __importDefault(require("path"));
const chatgpt_1 = require("./ai/chatgpt");
const gemini_1 = require("./ai/gemini");
const updater_1 = require("./ipc/updater");
const args = process.argv.slice(2);
exports.forceShowWorker = args.includes('--show-worker');
exports.forceAllowDevTools = args.includes('--allow-dev-tools');
exports.PROVIDER_STORAGE_KEY = 'fluxnotes-ai-provider';
exports.CHATGPT_URL = 'https://chatgpt.com/';
exports.GEMINI_SIGN_IN_URL = 'https://gemini.google.com/signin';
let mainWindow = null;
let sendWorkerWindow = null;
let loginCheckInterval = null;
let activeProvider = null;
const appServe = electron_1.app.isPackaged ? (0, electron_serve_1.default)({
    directory: path_1.default.join(__dirname, '../out'),
}) : null;
function getMainWindow() {
    return mainWindow;
}
function getWorkerWindow() {
    return sendWorkerWindow;
}
function disableDevTools(window) {
    if (exports.forceAllowDevTools)
        return;
    window.webContents.on('before-input-event', (event, input) => {
        const isDevToolsShortcut = input.key === 'F12'
            || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i');
        if (isDevToolsShortcut)
            event.preventDefault();
    });
    window.webContents.on('devtools-opened', () => window.webContents.closeDevTools());
}
function openAppLinksExternally(window) {
    window.webContents.setWindowOpenHandler(() => {
        return { action: 'allow' };
    });
    window.webContents.on('will-navigate', (_event, url) => {
        const isAppUrl = electron_1.app.isPackaged ? url.startsWith('app://') : url.startsWith('http://localhost:3000');
        if (!isAppUrl && !url.includes('chatgpt.com') && !url.includes('auth')) {
            return;
        }
    });
}
function isChatGptUrl(url) {
    try {
        return new URL(url).hostname === 'chatgpt.com';
    }
    catch {
        return false;
    }
}
function isGeminiUrl(url) {
    try {
        return new URL(url).hostname === 'gemini.google.com';
    }
    catch {
        return false;
    }
}
async function getSelectedProvider() {
    if (!mainWindow || mainWindow.isDestroyed())
        return null;
    if (electron_1.app.isPackaged)
        return 'chatgpt';
    const provider = await mainWindow.webContents.executeJavaScript(`window.localStorage.getItem(${JSON.stringify(exports.PROVIDER_STORAGE_KEY)})`);
    return provider === 'gemini' || provider === 'chatgpt' ? provider : null;
}
function isAuthProviderUrl(url) {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host === 'gemini.google.com')
            return false;
        const authHosts = [
            'accounts.google.com',
            'google.com',
            'login.microsoftonline.com',
            'login.live.com',
            'microsoft.com',
            'appleid.apple.com',
            'github.com',
            'githubusercontent.com',
            'auth0.com',
            'okta.com',
            'facebook.com',
            'twitter.com',
            'x.com',
            'linkedin.com',
            'discord.com',
        ];
        for (const authHost of authHosts) {
            if (host === authHost || host.endsWith('.' + authHost)) {
                return true;
            }
        }
        return false;
    }
    catch {
        return false;
    }
}
function startLoginCheckRoutine(resetSessionCallback) {
    if (exports.forceShowWorker)
        return;
    if (loginCheckInterval)
        clearInterval(loginCheckInterval);
    loginCheckInterval = setInterval(async () => {
        if (!sendWorkerWindow || sendWorkerWindow.isDestroyed())
            return;
        try {
            const provider = await getSelectedProvider();
            if (!provider) {
                if (sendWorkerWindow.isVisible())
                    sendWorkerWindow.hide();
                if (mainWindow && !mainWindow.isVisible() && !mainWindow.isMinimized()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
                return;
            }
            if (activeProvider && activeProvider !== provider) {
                resetSessionCallback();
            }
            activeProvider = provider;
            const currentUrl = sendWorkerWindow.webContents.getURL();
            const onAuthProvider = isAuthProviderUrl(currentUrl);
            if (onAuthProvider) {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                    console.log('[ELECTRON] Hiding main window during external auth flow.');
                    mainWindow.hide();
                }
                if (!sendWorkerWindow.isVisible()) {
                    console.log('[ELECTRON] Showing send worker window for auth provider login.');
                    sendWorkerWindow.show();
                    sendWorkerWindow.focus();
                }
                return;
            }
            const isOnProviderPage = provider === 'gemini'
                ? isGeminiUrl(currentUrl)
                : isChatGptUrl(currentUrl);
            if (!isOnProviderPage) {
                await sendWorkerWindow.loadURL(provider === 'gemini' ? exports.GEMINI_SIGN_IN_URL : exports.CHATGPT_URL);
                return;
            }
            const hasLoginText = provider === 'gemini'
                ? await sendWorkerWindow.webContents.executeJavaScript(`
          (function() {
            const bodyText = document.body ? document.body.innerText : "";
            return /Meet Gemini, your personal AI assistant/i.test(bodyText);
          })();
        `)
                : await sendWorkerWindow.webContents.executeJavaScript(`
          (function() {
            const bodyText = document.body ? document.body.innerText : "";
            return bodyText.includes("Log in") || bodyText.includes("Sign up");
          })();
        `);
            if (hasLoginText) {
                if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
                    console.log('[ELECTRON] Hiding main window due to login page detection.');
                    mainWindow.hide();
                }
                if (sendWorkerWindow && !sendWorkerWindow.isVisible()) {
                    console.log('[ELECTRON] Showing send worker window for login.');
                    sendWorkerWindow.show();
                    sendWorkerWindow.focus();
                }
            }
            else {
                if (sendWorkerWindow && !sendWorkerWindow.isDestroyed() && sendWorkerWindow.isVisible()) {
                    sendWorkerWindow.hide();
                }
                if (mainWindow && !mainWindow.isVisible() && !mainWindow.isMinimized()) {
                    mainWindow.show();
                    mainWindow.focus();
                }
            }
        }
        catch {
            // Ignore routine script evaluation errors during page transitions
        }
    }, 1000);
}
function registerWindowControlListeners() {
    electron_1.ipcMain.on('window-minimize', () => mainWindow?.minimize());
    electron_1.ipcMain.on('window-maximize', () => {
        if (mainWindow?.isMaximized())
            mainWindow.unmaximize();
        else
            mainWindow?.maximize();
    });
    electron_1.ipcMain.on('window-close', () => {
        if (loginCheckInterval) {
            clearInterval(loginCheckInterval);
            loginCheckInterval = null;
        }
        if (sendWorkerWindow && !sendWorkerWindow.isDestroyed()) {
            sendWorkerWindow.destroy();
        }
        electron_1.app.quit();
    });
}
async function createWindows(resetSessionCallback) {
    const appIconPath = path_1.default.join(__dirname, '../icons/favicon.png');
    mainWindow = new electron_1.BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        frame: false,
        icon: appIconPath,
        webPreferences: {
            preload: path_1.default.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            devTools: (!electron_1.app.isPackaged || exports.forceAllowDevTools),
        },
    });
    sendWorkerWindow = new electron_1.BrowserWindow({
        width: 800,
        height: 600,
        show: false,
        frame: false,
        icon: appIconPath,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            devTools: (!electron_1.app.isPackaged || exports.forceAllowDevTools),
        },
    });
    disableDevTools(mainWindow);
    disableDevTools(sendWorkerWindow);
    openAppLinksExternally(mainWindow);
    openAppLinksExternally(sendWorkerWindow);
    sendWorkerWindow.webContents.on('did-finish-load', async () => {
        if (!sendWorkerWindow)
            return;
        const currentUrl = sendWorkerWindow.webContents.getURL();
        const chatGptScript = (0, chatgpt_1.loadChatGptEngineScript)();
        const geminiScript = (0, gemini_1.loadGeminiEngineScript)();
        if (currentUrl.includes('chatgpt.com') && chatGptScript) {
            try {
                await sendWorkerWindow.webContents.executeJavaScript(chatGptScript);
                console.log('[ELECTRON] fluxnotes Engine injected into sendWorker.');
            }
            catch (err) {
                console.error('[ELECTRON] Failed to inject fluxnotes engine into sendWorker:', err);
            }
        }
        if (currentUrl.includes('gemini.google.com') && geminiScript) {
            try {
                await sendWorkerWindow.webContents.executeJavaScript(geminiScript);
                console.log('[ELECTRON] Gemini engine injected into sendWorker.');
            }
            catch (err) {
                console.error('[ELECTRON] Failed to inject Gemini engine into sendWorker:', err);
            }
        }
    });
    if (electron_1.app.isPackaged && appServe) {
        await appServe(mainWindow);
        await mainWindow.loadURL('app://-');
    }
    else {
        await mainWindow.loadURL('http://localhost:3000');
    }
    const selectedProvider = await getSelectedProvider();
    const workerUrl = selectedProvider === 'gemini'
        ? exports.GEMINI_SIGN_IN_URL
        : selectedProvider === 'chatgpt'
            ? exports.CHATGPT_URL
            : 'about:blank';
    await sendWorkerWindow.loadURL(workerUrl);
    if (exports.forceShowWorker) {
        mainWindow.show();
        sendWorkerWindow.show();
        if (exports.forceAllowDevTools) {
            mainWindow.webContents.openDevTools();
            sendWorkerWindow.webContents.openDevTools();
        }
    }
    else {
        startLoginCheckRoutine(resetSessionCallback);
    }
    (0, updater_1.checkForUpdatesIfPackaged)();
}
