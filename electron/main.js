const { app, BrowserWindow, dialog, ipcMain, nativeImage, protocol, shell } = require("electron");
const serve = require("electron-serve").default;
const path = require("path");
const fs = require("fs");
const { autoUpdater } = require('electron-updater');

// Check CLI flags for debug mode
const args = process.argv.slice(2);
const forceShowWorker = args.includes('--show-worker');
const forceAllowDevTools = args.includes('--allow-dev-tools');

// Configure autoUpdater settings
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

const appServe = app.isPackaged ? serve({
  directory: path.join(__dirname, "../out")
}) : null;

let mainWindow;
let sendWorkerWindow;
let pendingChatUrl = null;
let activeChatSessionId = null;
let activeChatSession = null;
let isChatGptLoggedIn = false;

function createChatSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}


let loginCheckInterval = null;

// Read the fluxnotes Engine script once on startup
let chatGptEngineScript = "";
try {
  chatGptEngineScript = fs.readFileSync(path.join(__dirname, 'chatgpt-engine.js'), 'utf8');
} catch (err) {
  console.error("WARNING: Could not load chatgpt-engine.js. Ensure it exists in the same directory.", err);
}

function disableDevTools(window) {
  if (forceAllowDevTools) return;
  window.webContents.on('before-input-event', (event, input) => {
    const isDevToolsShortcut = input.key === 'F12'
      || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i');
    if (isDevToolsShortcut) event.preventDefault();
  });
  window.webContents.on('devtools-opened', () => window.webContents.closeDevTools());
}

function openAppLinksExternally(window) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    // Force all window openings and popups to load internally within the Electron session
    return { action: 'allow' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    // Never allow any navigation to trigger external browser opening
    const isAppUrl = app.isPackaged ? url.startsWith('app://') : url.startsWith('http://localhost:3000');
    if (!isAppUrl && !url.includes('chatgpt.com') && !url.includes('auth')) {
      // Keep everything internal to the worker or main window contexts
      return;
    }
  });
}

function isChatGptUrl(url) {
  try {
    return new URL(url).hostname === 'chatgpt.com';
  } catch {
    return false;
  }
}

function isAuthProviderUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
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

function completeTruncatedJson(jsonText) {
  const stack = [];
  let inString = false;
  let isEscaped = false;
  let unfinishedStringIsKey = false;
  let previousNonWhitespace = '';

  for (const character of jsonText) {
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === '\\') {
        isEscaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      unfinishedStringIsKey = previousNonWhitespace === '{'
        || (previousNonWhitespace === ',' && stack.at(-1) === '}');
    } else if (character === '{') {
      stack.push('}');
    } else if (character === '[') {
      stack.push(']');
    } else if (character === '}' || character === ']') {
      if (stack.at(-1) === character) stack.pop();
    }

    if (!/\s/.test(character)) previousNonWhitespace = character;
  }

  let completed = jsonText.trim();
  if (inString) completed += unfinishedStringIsKey ? '": null' : '"';
  if (/:\\s*$/.test(completed)) completed += 'null';
  completed = completed.replace(/,\\s*$/, '');

  return completed + stack.reverse().join('');
}

function findJsonObjectEnd(text, startIndex) {
  const stack = [];
  let inString = false;
  let isEscaped = false;

  for (let index = startIndex; index < text.length; index++) {
    const character = text[index];
    if (inString) {
      if (isEscaped) isEscaped = false;
      else if (character === '\\') isEscaped = true;
      else if (character === '"') inString = false;
      continue;
    }

    if (character === '"') inString = true;
    else if (character === '{') stack.push('}');
    else if (character === '[') stack.push(']');
    else if (character === '}' || character === ']') {
      if (stack.at(-1) !== character) return -1;
      stack.pop();
      if (stack.length === 0) return index + 1;
    }
  }

  return -1;
}

function extractJsonFromResponse(rawText) {
  const text = rawText
    .replace(/<br\s*[\/]?>/gi, '\n')
    .replace(/<\/?[^>]+(>|$)/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();

  // Prefer fenced JSON, because Markdown prose may contain other braces.
  const fencedBlocks = text.matchAll(/```(?:json|javascript|js)?\s*([\s\S]*?)```/gi);
  for (const match of fencedBlocks) {
    const candidate = match[1].trim();
    if (candidate.startsWith('{')) return candidate;
  }

  const firstBrace = text.indexOf('{');
  if (firstBrace === -1) throw new Error('No JSON object found in response');

  const endIndex = findJsonObjectEnd(text, firstBrace);
  return endIndex === -1 ? text.slice(firstBrace) : text.slice(firstBrace, endIndex);
}

function completeNotePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (!['new', 'update'].includes(payload.status)) return payload;

  const subTopics = Array.isArray(payload.subTopics) ? payload.subTopics : [];
  const recommendedResponse = Array.isArray(payload.recommendedResponse)
    ? payload.recommendedResponse.filter((response) => typeof response === 'string' && response.trim())
    : [];
  if (!recommendedResponse.some((response) => response.trim().toLowerCase() === 'continue')) {
    recommendedResponse.push('Continue');
  }

  return {
    ...payload,
    status: payload.status,
    topicName: typeof payload.topicName === 'string' ? payload.topicName : '',
    topicId: typeof payload.topicId === 'string' ? payload.topicId : '',
    subTopics: subTopics.map((subTopic, index) => ({
      names: Array.isArray(subTopic?.names)
        ? subTopic.names.filter((name) => typeof name === 'string' && name.trim())
        : [],
      pageNumber: subTopic?.pageNumber ?? String(index + 1),
    })),
    aiResponse: typeof payload.aiResponse === 'string' ? payload.aiResponse : '',
    recommendedResponse,
  };
}

// Setup Local JSON Storage in User Data Folder
const dataFilePath = path.join(app.getPath('userData'), 'notes_data.json');
const imagesDir = path.join(app.getPath('userData'), 'images');

if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

let dataFileCache = null;

async function readDataFileAsync() {
  if (dataFileCache !== null) {
    return structuredClone(dataFileCache);
  }

  try {
    if (fs.existsSync(dataFilePath)) {
      const rawData = await fs.promises.readFile(dataFilePath, 'utf-8');
      const parsed = JSON.parse(rawData);
      dataFileCache = {
        notes_collection: Array.isArray(parsed.notes_collection) ? parsed.notes_collection : [],
        image_records: Array.isArray(parsed.image_records) ? parsed.image_records : []
      };
      return structuredClone(dataFileCache);
    }
  } catch (err) {
    console.error('Failed to read local JSON data file:', err);
  }

  dataFileCache = { notes_collection: [], image_records: [] };
  return structuredClone(dataFileCache);
}

async function writeDataFileAsync(data) {
  try {
    await fs.promises.writeFile(dataFilePath, JSON.stringify(data, null, 2), 'utf-8');
    // Update in-memory cache only after successful write
    dataFileCache = {
      notes_collection: structuredClone(data.notes_collection || []),
      image_records: structuredClone(data.image_records || [])
    };
  } catch (err) {
    console.error('Failed to write local JSON data file:', err);
  }
}

async function getStoredNotes() {
  const data = await readDataFileAsync();
  return data.notes_collection;
}

async function getStoredRecords() {
  const data = await readDataFileAsync();
  return data.image_records;
}

async function saveRecordToDb(record) {
  const data = await readDataFileAsync();
  data.image_records.push(record);
  await writeDataFileAsync(data);
}

async function saveNotesCollection(notes) {
  const data = await readDataFileAsync();
  data.notes_collection = notes;
  await writeDataFileAsync(data);
}

async function saveImageRecords(records) {
  const data = await readDataFileAsync();
  data.image_records = records;
  await writeDataFileAsync(data);
}

function toLocalImageUrl(filePath) {
  return `local://${encodeURI(filePath.replace(/\\/g, '/'))}`;
}

function fromLocalImageUrl(value) {
  return value.startsWith('local://') ? decodeURI(value.replace(/^local:\/\//, '')) : value;
}

function safeFileName(name) {
  return (name || 'notes').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').trim() || 'notes';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

const RESULT_JSON_PATH = path.resolve(__dirname, '..', 'result.json');

function appendToResultJson(entry) {
  if(!app.isPackaged) {
    try {
    let arr = [];
    try {
      if (fs.existsSync(RESULT_JSON_PATH)) {
        const raw = fs.readFileSync(RESULT_JSON_PATH, 'utf8');
        if (raw && raw.trim()) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) arr = parsed;
        }
      }
    } catch (e) {
      console.warn('[result.json] Failed to read existing file, starting fresh:', e.message);
      arr = [];
    }
    arr.push({
      timestamp: new Date().toISOString(),
      ...entry,
    });
    fs.writeFileSync(RESULT_JSON_PATH, JSON.stringify(arr, null, 2), 'utf8');
    console.log(`[result.json] Appended entry #${arr.length} -> ${RESULT_JSON_PATH}`);
  } catch (writeErr) {
    console.error('[result.json] Failed to write:', writeErr.message);
  }
  }
}

// --- Auto-Updater IPC Handlers & Events ---
ipcMain.handle('check-for-updates', async () => {
  if (!app.isPackaged) return { status: 'dev-mode' };
  try {
    const res = await autoUpdater.checkForUpdatesAndNotify();
    return { status: 'checking', info: res };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('restart-to-update', () => {
  autoUpdater.quitAndInstall(false, true);
});

autoUpdater.on('update-available', (info) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-event', { type: 'update-available', info });
  }
});

autoUpdater.on('download-progress', (progressObj) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-event', { type: 'download-progress', progress: progressObj.percent });
  }
});

autoUpdater.on('update-downloaded', (info) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater-event', { type: 'update-downloaded', info });
  }
});

// --- Notes App IPC Handlers ---
ipcMain.handle('get-all-notes', async () => {
  return await getStoredNotes();
});

ipcMain.handle('get-note-by-id', async (_, topicId) => {
  const notes = await getStoredNotes();
  return notes.find(n => n.topicId === topicId) || null;
});

ipcMain.handle('start-new-chat', async () => {
  pendingChatUrl = null;
  activeChatSessionId = createChatSessionId();
  activeChatSession = { conversationId: null, parentMessageId: null };
  if (sendWorkerWindow && !sendWorkerWindow.isDestroyed()) {
    await sendWorkerWindow.loadURL('https://chatgpt.com/');
  }
  return { sessionId: activeChatSessionId };
});

ipcMain.handle('set-note-chat-session', (_, { chatUrl, sessionId, session }) => {
  pendingChatUrl = typeof chatUrl === 'string' && isChatGptUrl(chatUrl) ? chatUrl : null;
  activeChatSessionId = typeof sessionId === 'string' && sessionId ? sessionId : createChatSessionId();
  activeChatSession = session && typeof session === 'object'
    ? {
        conversationId: typeof session.conversationId === 'string' ? session.conversationId : null,
        parentMessageId: typeof session.parentMessageId === 'string' ? session.parentMessageId : null,
      }
    : {
        conversationId: pendingChatUrl ? pendingChatUrl.match(/\/c\/([^/?#]+)/)?.[1] || null : null,
        parentMessageId: null,
      };
  return true;
});

ipcMain.handle('save-note', async (_, noteData) => {
  const notes = await getStoredNotes();
  const chatUrl = noteData.chatUrl || (sendWorkerWindow ? sendWorkerWindow.webContents.getURL() : "");
  const savedImages = Array.isArray(noteData.images)
    ? noteData.images
      .map((imagePath) => typeof imagePath === 'string' ? fromLocalImageUrl(imagePath) : '')
      .filter((imagePath) => imagePath.startsWith(imagesDir) && fs.existsSync(imagePath))
      .map(toLocalImageUrl)
    : [];

  const fullNoteRecord = {
    ...noteData,
    images: savedImages,
    chatUrl,
    chatSessionId: noteData.chatSessionId || activeChatSessionId || null,
    chatSession: noteData.chatSession || activeChatSession || null,
    timestamp: Date.now()
  };

  const existingIndex = notes.findIndex(n => n.topicId === noteData.topicId);
  if (existingIndex >= 0) {
    notes[existingIndex] = { ...notes[existingIndex], ...fullNoteRecord };
  } else {
    notes.push(fullNoteRecord);
  }

  await saveNotesCollection(notes);
  return true;
});

ipcMain.handle('rename-note', async (_, { topicId, topicName }) => {
  const name = typeof topicName === 'string' ? topicName.trim() : '';
  if (!name) return { success: false, error: 'A note name is required.' };

  const notes = await getStoredNotes();
  const index = notes.findIndex((note) => note.topicId === topicId);
  if (index === -1) return { success: false, error: 'Note not found.' };

  notes[index] = { ...notes[index], topicName: name };
  await saveNotesCollection(notes);
  return { success: true };
});

ipcMain.handle('set-note-pinned', async (_, { topicId, pinned }) => {
  const notes = await getStoredNotes();
  const index = notes.findIndex((note) => note.topicId === topicId);
  if (index === -1) return { success: false, error: 'Note not found.' };

  notes[index] = { ...notes[index], pinned: Boolean(pinned) };
  await saveNotesCollection(notes);
  return { success: true };
});

ipcMain.handle('delete-note', async (_, topicId) => {
  const notes = await getStoredNotes();
  const noteToDelete = notes.find((note) => note.topicId === topicId);
  if (!noteToDelete) return { success: false, error: 'Note not found.' };

  const remainingNotes = notes.filter((note) => note.topicId !== topicId);
  const remainingImagePaths = new Set(remainingNotes.flatMap((note) => (
    Array.isArray(note.images) ? note.images.map(fromLocalImageUrl) : []
  )));
  const removableImagePaths = (noteToDelete.images || [])
    .map(fromLocalImageUrl)
    .filter((imagePath) => imagePath.startsWith(imagesDir) && !remainingImagePaths.has(imagePath));

  await Promise.all(removableImagePaths.map(async (imagePath) => {
    try {
      await fs.promises.unlink(imagePath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }));
  await saveNotesCollection(remainingNotes);

  const removedPaths = new Set(removableImagePaths);
  const records = await getStoredRecords();
  await saveImageRecords(records.filter((record) => !removedPaths.has(record.filePath)));
  return { success: true };
});

ipcMain.handle('export-note', async (_, { images, topicName, format }) => {
  const imagePaths = Array.isArray(images)
    ? images.map((imagePath) => typeof imagePath === 'string' ? fromLocalImageUrl(imagePath) : '')
      .filter((imagePath) => fs.existsSync(imagePath))
    : [];

  if (imagePaths.length === 0) {
    return { success: false, error: 'There are no generated pages to export.' };
  }

  const fileName = safeFileName(topicName);

  if (format === 'pdf') {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export notes as PDF',
      defaultPath: `${fileName}.pdf`,
      filters: [{ name: 'PDF document', extensions: ['pdf'] }],
    });
    if (canceled || !filePath) return { success: false, canceled: true };

    const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, devTools: false } });
    disableDevTools(printWindow);
    try {
      const pagesHtml = imagePaths.map((imagePath, index) => (
        `<section class="page"><img src="${toLocalImageUrl(imagePath)}" alt="Page ${index + 1}" /></section>`
      )).join('');
      const html = `<!doctype html><html><head><meta charset="utf-8" />
        <title>${escapeHtml(topicName || 'Notes')}</title>
        <style>
          @page { size: A4; margin: 0; }
          html, body { margin: 0; padding: 0; background: white; }
          .page { width: 210mm; height: 297mm; break-after: page; overflow: hidden; display: flex; align-items: center; justify-content: center; }
          .page:last-child { break-after: auto; }
          img { display: block; width: 100%; height: 100%; object-fit: contain; }
        </style>
        </head><body>${pagesHtml}</body></html>`;
      await printWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await printWindow.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true });
      await fs.promises.writeFile(filePath, pdf);
      return { success: true, path: filePath, count: imagePaths.length };
    } finally {
      if (!printWindow.isDestroyed()) printWindow.destroy();
    }
  }

  if (format === 'png' || format === 'jpeg') {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: `Export notes as ${format.toUpperCase()} images`,
      properties: ['openDirectory', 'createDirectory'],
    });
    const outputDirectory = filePaths[0];
    if (canceled || !outputDirectory) return { success: false, canceled: true };

    await Promise.all(imagePaths.map(async (imagePath, index) => {
      const pageNumber = String(index + 1).padStart(2, '0');
      const outputPath = path.join(outputDirectory, `${fileName}-page-${pageNumber}.${format === 'jpeg' ? 'jpg' : 'png'}`);
      if (format === 'png') {
        await fs.promises.copyFile(imagePath, outputPath);
      } else {
        const jpegData = nativeImage.createFromPath(imagePath).toJPEG(95);
        await fs.promises.writeFile(outputPath, jpegData);
      }
    }));

    return { success: true, path: outputDirectory, count: imagePaths.length };
  }

  return { success: false, error: 'Unsupported export format.' };
});

function startLoginCheckRoutine() {
  if (forceShowWorker) return;
  if (loginCheckInterval) clearInterval(loginCheckInterval);
  loginCheckInterval = setInterval(async () => {
    if (!sendWorkerWindow || sendWorkerWindow.isDestroyed()) return;
    try {
      const currentUrl = sendWorkerWindow.webContents.getURL();
      const onAuthProvider = isAuthProviderUrl(currentUrl);

      if (onAuthProvider) {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          console.log("[ELECTRON] Hiding main window during external auth flow.");
          mainWindow.hide();
        }
        if (sendWorkerWindow && !sendWorkerWindow.isVisible()) {
          console.log("[ELECTRON] Showing send worker window for auth provider login.");
          sendWorkerWindow.show();
          sendWorkerWindow.focus();
        }
        return;
      }

      if (!currentUrl.includes('chatgpt.com')) {
        return;
      }
      const hasLoginText = await sendWorkerWindow.webContents.executeJavaScript(`
        (function() {
          const bodyText = document.body ? document.body.innerText : "";
          return bodyText.includes("Log in") || bodyText.includes("Sign up");
        })();
      `);
      isChatGptLoggedIn = !hasLoginText;
      if (hasLoginText) {
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
          console.log("[ELECTRON] Hiding main window due to login page detection.");
          mainWindow.hide();
        }
        if (sendWorkerWindow && !sendWorkerWindow.isVisible()) {
          console.log("[ELECTRON] Showing send worker window for login.");
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
    } catch {
      // Ignore routine script evaluation errors during page transitions
    }
  }, 1000);
}

const createWindow = async () => {
  const appIconPath = path.join(__dirname, '../icons/favicon.png'); // Adjust to your actual icon file path

  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    icon: appIconPath,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: (!app.isPackaged || forceAllowDevTools),
    }
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

  // Apply external link protection to ALL windows so no webviews accidentally navigate away internally
  openAppLinksExternally(mainWindow);
  openAppLinksExternally(sendWorkerWindow);

  sendWorkerWindow.webContents.on('did-finish-load', async () => {
    const currentUrl = sendWorkerWindow.webContents.getURL();
    if (currentUrl.includes('chatgpt.com') && chatGptEngineScript) {
      try {
        await sendWorkerWindow.webContents.executeJavaScript(chatGptEngineScript);
        const hasLoginText = await sendWorkerWindow.webContents.executeJavaScript(`
          document.body ? /\\b(Log in|Sign up)\\b/.test(document.body.innerText) : true
        `);
        isChatGptLoggedIn = !hasLoginText;
        console.log("[ELECTRON] fluxnotes Engine injected into sendWorker.");
      } catch (err) {
        console.error("[ELECTRON] Failed to inject fluxnotes engine into sendWorker:", err);
      }
    }
  });

  if (app.isPackaged) {
    await appServe(mainWindow);
    mainWindow.loadURL("app://-");
  } else {
    mainWindow.loadURL("http://localhost:3000");
  }

  await sendWorkerWindow.loadURL("https://chatgpt.com/");

  if (forceShowWorker) {
    mainWindow.show();
    sendWorkerWindow.show();
    if (forceAllowDevTools) {
      mainWindow.webContents.openDevTools();
      sendWorkerWindow.webContents.openDevTools();
    }
  } else {
    startLoginCheckRoutine();
  }

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.log("Failed to check for updates:", err);
    });
  }

};

ipcMain.handle('get-stored-images', async () => {
  const records = await getStoredRecords();
  return records
    .filter(rec => fs.existsSync(rec.filePath))
    .map(rec => toLocalImageUrl(rec.filePath));
});

ipcMain.on('window-minimize', () => mainWindow?.minimize());
ipcMain.on('window-maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window-close', () => mainWindow?.close());

ipcMain.handle('fill-chatgpt-input', async (event, userText) => {
  if (!sendWorkerWindow) return false;

  if (!activeChatSessionId) {
    activeChatSessionId = createChatSessionId();
    activeChatSession = { conversationId: null, parentMessageId: null };
  }
  const sessionId = activeChatSessionId;
  try {
    let promptContent = "";
    try {
      const promptPath = path.join(__dirname, '../prompt.md');
      if (fs.existsSync(promptPath)) {
        promptContent = fs.readFileSync(promptPath, 'utf-8');
      }
    } catch (error) {
      console.error("Failed to read prompt.md:", error);
    }
    const isEngineLoaded = await sendWorkerWindow.webContents.executeJavaScript(`typeof window.__fluxnotesChatGPT !== 'undefined'`);
    if (!isEngineLoaded && chatGptEngineScript) {
      console.log("[ELECTRON] fluxnotes engine missing. Injecting now...");
      await sendWorkerWindow.webContents.executeJavaScript(chatGptEngineScript);
    }

    // The Electron process owns the session. The page never restores a session
    // from localStorage, so a new note cannot accidentally continue an old one.
    const session = activeChatSession;
    const result = await sendWorkerWindow.webContents.executeJavaScript(`
      (async function() {
        if (!window.__fluxnotesChatGPT) {
          throw new Error("fluxnotes engine not loaded.");
        }

        const sysPrompt = ${JSON.stringify(promptContent)};
        const usrText = ${JSON.stringify(userText)};
        const sessionId = ${JSON.stringify(sessionId)};
        const session = ${JSON.stringify(session)};
        window.__fluxnotesChatGPT.setSession(sessionId, session);

        const currentConvoId = window.__fluxnotesChatGPT.getConversationId(sessionId);

        if (!currentConvoId && sysPrompt.trim() !== "") {
          console.log("[INJECTION] Sending initial system prompt to thread...");
          await window.__fluxnotesChatGPT.send(sysPrompt, 'chatgpt', null, sessionId);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log("[INJECTION] Sending user query to the same conversation thread...");
        let finalOutput = await window.__fluxnotesChatGPT.send(usrText, 'chatgpt', null, sessionId);
        const finalText = String(finalOutput && finalOutput.text ? finalOutput.text : "").trim();

        if (!finalText) {
          console.log("[INJECTION] Empty image response text. Sending SEND_IMAGE_INFO request.");
          finalOutput = await window.__fluxnotesChatGPT.send(JSON.stringify({ status: "SEND_IMAGE_INFO" }), 'chatgpt', null, sessionId);
        }

        const activeConvoId = finalOutput.conversationId || window.__fluxnotesChatGPT.getConversationId(sessionId);
        const useMessageId = finalOutput.messageId || null;
        console.log(finalOutput);

        const generatedImages = Array.isArray(finalOutput.generatedImages) ? finalOutput.generatedImages : [];
        const dedupedGeneratedImages = [];
        const dedupeMap = new Map();
        for (const img of generatedImages) {
          if (!img || (!img.imagePath && !img.fileId && !img.generationId)) continue;
          const key = String(img.imagePath || img.fileId || img.generationId || '').trim();
          if (!key) continue;
          const existing = dedupeMap.get(key);
          if (!existing) {
            dedupeMap.set(key, { ...img });
            dedupedGeneratedImages.push({ ...img });
          } else {
            Object.entries(img).forEach(([field, value]) => {
              if (value != null && value !== '' && (existing[field] == null || existing[field] === '')) {
                existing[field] = value;
              }
            });
          }
        }

        const validateSandboxDownload = function (download) {
          if (!download || typeof download.base64 !== 'string' || download.base64.length < 128) {
            return { valid: false, reason: 'missing or tiny base64 payload' };
          }
          try {
            const decoded = atob(download.base64);
            if (decoded.length < 64) {
              return { valid: false, reason: 'payload too short to be a valid image' };
            }
            const header = decoded.slice(0, 16);
            const pngHeader = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A].map((byte) => String.fromCharCode(byte)).join('');
            const jpegStart = [0xFF, 0xD8, 0xFF].map((byte) => String.fromCharCode(byte)).join('');
            const hasValidHeader =
              header.startsWith(pngHeader) ||
              header.startsWith(jpegStart) ||
              header.startsWith('RIFF') ||
              header.startsWith('GIF87a') ||
              header.startsWith('GIF89a');
            if (!hasValidHeader) {
              return { valid: false, reason: 'bad file signature' };
            }
            return { valid: true };
          } catch (error) {
            return { valid: false, reason: (error && error.message) ? error.message : String(error) };
          }
        };

        const downloadOneSandboxImage = async function (img) {
          const attempts = 2;
          for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
              const download = await window.__fluxnotesChatGPT.downloadSandboxImage(img.imagePath, useMessageId, sessionId);
              const validation = validateSandboxDownload(download);
              if (validation.valid) {
                console.log("[ELECTRON] Valid sandbox image download confirmed:", {
                  imagePath: img.imagePath,
                  attempt,
                  size: download && typeof download.size === 'number' ? download.size : null,
                });
                return { ...img, download };
              }
              console.warn("[ELECTRON] Invalid sandbox image payload; retrying:", {
                imagePath: img.imagePath,
                attempt,
                reason: validation.reason,
              });
              if (attempt === attempts) {
                return { ...img, downloadError: validation.reason || 'Invalid sandbox image payload' };
              }
            } catch (error) {
              const message = error && error.message ? error.message : String(error);
              console.warn("[ELECTRON] Sandbox image download failed; retrying:", {
                imagePath: img.imagePath,
                attempt,
                reason: message,
              });
              if (attempt === attempts) {
                return { ...img, downloadError: message };
              }
            }
          }
          return { ...img, downloadError: 'Sandbox image failed validation after retries' };
        };

        const sandboxDownloads = [];
        for (let gi = 0; gi < dedupedGeneratedImages.length; gi++) {
          const img = dedupedGeneratedImages[gi];
          if (img && img.imagePath && useMessageId && typeof window.__fluxnotesChatGPT.downloadSandboxImage === 'function') {
            console.log("[ELECTRON] Starting sandbox image download from generated image payload:", {
              imagePath: img.imagePath,
              fileId: img.fileId || null,
              generationId: img.generationId || null,
              messageId: useMessageId,
              sessionId: sessionId || null,
            });
            sandboxDownloads.push(downloadOneSandboxImage(img));
          }
        }
        const downloadedImages = sandboxDownloads.length ? await Promise.all(sandboxDownloads) : [];

        return {
          rawText: finalOutput.text || finalOutput,
          messageId: useMessageId,
          conversationId: activeConvoId,
          session: window.__fluxnotesChatGPT.getSession(sessionId),
          generationId: finalOutput.generationId || null,
          fileId: finalOutput.fileId || null,
          generatedImages: dedupedGeneratedImages,
          downloadedSandboxImages: downloadedImages,
        };

        
      })();
    `);

    if (result) {
      const { rawText = "", conversationId, messageId, session, generationId, fileId, generatedImages, downloadedSandboxImages } = result;
      activeChatSession = session || activeChatSession;

      appendToResultJson({
        sessionId: sessionId || null,
        messageId: messageId || null,
        conversationId: conversationId || null,
        generationId: generationId || null,
        fileId: fileId || null,
        response: rawText,
        generatedImages: generatedImages || null,
      });

      if (Array.isArray(downloadedSandboxImages) && downloadedSandboxImages.length > 0) {
        for (const img of downloadedSandboxImages) {
          if (!img || !img.download || !img.download.base64) continue;
          const base64Data = String(img.download.base64);
          const ext = (img.download.mimeType && img.download.mimeType.split('/')[1]) || 'png';
          const safeExt = ext === 'jpeg' ? 'jpg' : ext.replace(/[^a-zA-Z0-9]/g, '');
          const usedFileId = String(img.fileId || fileId || generationId || messageId || 'unknown');
          const noteIdValue = String(sessionId || activeChatSessionId || messageId || 'note');
          const fileName = `image_${safeFileName(noteIdValue)}_${safeFileName(usedFileId)}.${safeExt}`;
          const filePath = path.join(imagesDir, fileName);
          try {
            console.log("[ELECTRON] Saving downloaded sandbox image to disk:", {
              imagePath: img.imagePath || img.download.imagePath || null,
              fileId: img.fileId || fileId || null,
              generationId: img.generationId || generationId || null,
              destination: filePath,
            });
            fs.writeFileSync(filePath, base64Data, 'base64');
            console.log("[ELECTRON] Sandbox image saved locally:", filePath);
            await saveRecordToDb({ id: usedFileId, filePath, timestamp: Date.now(), source: 'sandbox', generationId: img.generationId || generationId, fileId: img.fileId || fileId });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('new-image', { filePath: toLocalImageUrl(filePath), pageNumber: null });
              console.log("[ELECTRON] Sent new-image event with local path:", toLocalImageUrl(filePath));
            }
          } catch (saveErr) {
            console.error("[ELECTRON] Failed to save sandbox image locally:", saveErr.message);
          }
        }
      }

      if (!rawText) return null;

      // Text responses are rendered once so their chat URL remains available.
      

      try {
        const jsonText = extractJsonFromResponse(rawText);
        const jsonData = completeNotePayload(JSON.parse(completeTruncatedJson(jsonText)));

        if (conversationId) {
          jsonData.chatUrl = `https://chatgpt.com/c/${conversationId}`;
        }
        jsonData.chatSessionId = sessionId;
        jsonData.chatSession = activeChatSession;
        if (messageId) jsonData.messageId = messageId;
        if (generationId) jsonData.generationId = generationId;
        if (fileId) jsonData.fileId = fileId;
        if (Array.isArray(generatedImages)) jsonData.generatedImages = generatedImages;

        console.log("[ELECTRON] Successfully processed conversation and images:", jsonData.topicName);
        return jsonData;
      } catch (parseErr) {
        console.error("[ELECTRON] JSON Parse Error:", parseErr.message);
        return { error: "Failed to parse JSON", raw: rawText, messageId: messageId, conversationId: conversationId, generationId, fileId, generatedImages };
      }
    }
    return null;

  } catch (err) {
    console.error("Failed to execute fluxnotes API script:", err);
    appendToResultJson({
      sessionId: sessionId || null,
      error: err && err.message ? String(err.message) : String(err),
      errorStack: err && err.stack ? String(err.stack) : null,
    });
    return false;
  }
});
// Setup Results Directory inside User Data Folder
const resultsDir = path.join(app.getPath('userData'), 'results');
if (!fs.existsSync(resultsDir)) {
  fs.mkdirSync(resultsDir, { recursive: true });
}

ipcMain.handle('save-raw-result', async (_, { sessionId, rawContent, conversationId }) => {
  try {
    const safeId = (sessionId || 'default').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
    const resultFilePath = path.join(resultsDir, `result-${safeId}.json`);
    const fileData = {
      sessionId,
      conversationId: conversationId || null,
      timestamp: Date.now(),
      rawResponse: rawContent
    };
    await fs.promises.writeFile(resultFilePath, JSON.stringify(fileData, null, 2), 'utf-8');
    console.log("[ELECTRON] Raw result saved to:", resultFilePath);
    return { success: true };
  } catch (err) {
    console.error("Failed to save raw result file:", err);
    return { success: false, error: err.message };
  }
});

app.whenReady().then(() => {
  protocol.registerFileProtocol('local', (request, callback) => {
    const url = request.url.replace(/^local:\/\//, '');
    let decodedPath = decodeURI(url);
    if (process.platform === 'win32' && decodedPath.startsWith('/')) {
      decodedPath = decodedPath.slice(1);
    }
    callback({ path: decodedPath });
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
