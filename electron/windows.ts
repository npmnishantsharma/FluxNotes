import { app, BrowserWindow, ipcMain } from 'electron';
import serve from 'electron-serve';
import path from 'path';
import { loadChatGptEngineScript } from './ai/chatgpt';
import { loadGeminiEngineScript } from './ai/gemini';
import { checkForUpdatesIfPackaged } from './ipc/updater';

const args = process.argv.slice(2);
export const forceShowWorker = args.includes('--show-worker');
export const forceAllowDevTools = args.includes('--allow-dev-tools');

export const PROVIDER_STORAGE_KEY = 'fluxnotes-ai-provider';
export const CHATGPT_URL = 'https://chatgpt.com/';
export const CHATGPT_LOGIN_URL = 'https://chatgpt.com/auth/login/';
export const GEMINI_SIGN_IN_URL = 'https://gemini.google.com/signin';

let mainWindow: BrowserWindow | null = null;
let sendWorkerWindow: BrowserWindow | null = null;
let loginCheckInterval: NodeJS.Timeout | null = null;
let activeProvider: string | null = null;

const appServe = app.isPackaged ? serve({
  directory: path.join(__dirname, '../out'),
}) : null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function getWorkerWindow(): BrowserWindow | null {
  return sendWorkerWindow;
}

export function disableDevTools(window: BrowserWindow): void {
  if (forceAllowDevTools) return;
  window.webContents.on('before-input-event', (event, input) => {
    const isDevToolsShortcut = input.key === 'F12'
      || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i');
    if (isDevToolsShortcut) event.preventDefault();
  });
  window.webContents.on('devtools-opened', () => window.webContents.closeDevTools());
}

export function openAppLinksExternally(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(() => {
    return { action: 'allow' };
  });
  window.webContents.on('will-navigate', (_event, url) => {
    const isAppUrl = app.isPackaged ? url.startsWith('app://') : url.startsWith('http://localhost:3000');
    if (!isAppUrl && !url.includes('chatgpt.com') && !url.includes('auth')) {
      return;
    }
  });
}

export function isChatGptUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

export function isGeminiUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'gemini.google.com';
  } catch {
    return false;
  }
}

export async function getSelectedProvider(): Promise<string | null> {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const provider = await mainWindow.webContents.executeJavaScript(
    `window.localStorage.getItem(${JSON.stringify(PROVIDER_STORAGE_KEY)})`,
  );
  return provider === 'gemini' || provider === 'chatgpt' ? provider : null;
}

export function isAuthProviderUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'gemini.google.com') return false;

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
  } catch {
    return false;
  }
}

export function startLoginCheckRoutine(resetSessionCallback: () => void): void {
  if (forceShowWorker) return;
  if (loginCheckInterval) clearInterval(loginCheckInterval);
  loginCheckInterval = setInterval(async () => {
    if (!sendWorkerWindow || sendWorkerWindow.isDestroyed()) return;
    try {
      const provider = await getSelectedProvider();

      if (!provider) {
        if (sendWorkerWindow.isVisible()) sendWorkerWindow.hide();
        if (mainWindow && !mainWindow.isVisible()) {
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

      if (provider === 'gemini') {
        if (!isGeminiUrl(currentUrl)) {
          await sendWorkerWindow.loadURL(GEMINI_SIGN_IN_URL);
          return;
        }

        const hasGeminiLoginText = await sendWorkerWindow.webContents.executeJavaScript(`
          (function() {
            const bodyText = document.body ? document.body.innerText : "";
            return /Meet Gemini, your personal AI assistant/i.test(bodyText);
          })();
        `);

        if (hasGeminiLoginText) {
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            mainWindow.hide();
          }
          if (sendWorkerWindow && !sendWorkerWindow.isVisible()) {
            sendWorkerWindow.show();
            sendWorkerWindow.focus();
          }
        } else {
          if (sendWorkerWindow && !sendWorkerWindow.isDestroyed() && sendWorkerWindow.isVisible()) {
            sendWorkerWindow.hide();
          }
          if (mainWindow && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      } else {
        // ChatGPT login detection:
        // If on /auth/login/ or auth subpath, user is not logged in.
        // If redirected away to chatgpt.com (non-auth), user is logged in.
        const isOnAuthPage = currentUrl.includes('/auth/login') || currentUrl.includes('/auth/');
        if (!isChatGptUrl(currentUrl)) {
          await sendWorkerWindow.loadURL(CHATGPT_LOGIN_URL);
          return;
        }

        if (isOnAuthPage) {
          if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
            console.log('[ELECTRON] Hiding main window due to ChatGPT login page detection.');
            mainWindow.hide();
          }
          if (sendWorkerWindow && !sendWorkerWindow.isVisible()) {
            console.log('[ELECTRON] Showing send worker window for ChatGPT login.');
            sendWorkerWindow.show();
            sendWorkerWindow.focus();
          }
        } else {
          if (sendWorkerWindow && !sendWorkerWindow.isDestroyed() && sendWorkerWindow.isVisible()) {
            sendWorkerWindow.hide();
          }
          if (mainWindow && !mainWindow.isVisible()) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      }
    } catch {
      // Ignore routine script evaluation errors during page transitions
    }
  }, 1000);
}

export function registerWindowControlListeners(): void {
  ipcMain.on('window-minimize', () => mainWindow?.minimize());
  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.on('window-close', () => mainWindow?.close());
}

export async function createWindows(resetSessionCallback: () => void): Promise<void> {
  const appIconPath = path.join(__dirname, '../icons/favicon.png');

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: (!app.isPackaged || forceAllowDevTools),
    },
  });

  sendWorkerWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    icon: appIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: (!app.isPackaged || forceAllowDevTools),
    },
  });

  disableDevTools(mainWindow);
  disableDevTools(sendWorkerWindow);

  openAppLinksExternally(mainWindow);
  openAppLinksExternally(sendWorkerWindow);

  sendWorkerWindow.webContents.on('did-finish-load', async () => {
    if (!sendWorkerWindow) return;
    const currentUrl = sendWorkerWindow.webContents.getURL();
    const chatGptScript = loadChatGptEngineScript();
    const geminiScript = loadGeminiEngineScript();

    if (currentUrl.includes('chatgpt.com') && chatGptScript) {
      try {
        await sendWorkerWindow.webContents.executeJavaScript(chatGptScript);
        console.log('[ELECTRON] fluxnotes Engine injected into sendWorker.');
      } catch (err) {
        console.error('[ELECTRON] Failed to inject fluxnotes engine into sendWorker:', err);
      }
    }
    if (currentUrl.includes('gemini.google.com') && geminiScript) {
      try {
        await sendWorkerWindow.webContents.executeJavaScript(geminiScript);
        console.log('[ELECTRON] Gemini engine injected into sendWorker.');
      } catch (err) {
        console.error('[ELECTRON] Failed to inject Gemini engine into sendWorker:', err);
      }
    }
  });

  if (app.isPackaged && appServe) {
    await appServe(mainWindow);
    await mainWindow.loadURL('app://-');
  } else {
    await mainWindow.loadURL('http://localhost:3000');
  }

  const selectedProvider = await getSelectedProvider();
  const workerUrl = selectedProvider === 'gemini'
    ? GEMINI_SIGN_IN_URL
    : selectedProvider === 'chatgpt'
      ? CHATGPT_LOGIN_URL
      : 'about:blank';
  await sendWorkerWindow.loadURL(workerUrl);

  if (forceShowWorker) {
    mainWindow.show();
    sendWorkerWindow.show();
    if (forceAllowDevTools) {
      mainWindow.webContents.openDevTools();
      sendWorkerWindow.webContents.openDevTools();
    }
  } else {
    startLoginCheckRoutine(resetSessionCallback);
  }

  checkForUpdatesIfPackaged();
}
