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
let hiddenWorkerWindow;
let processedUrls = new Set();
let pendingChatUrl = null;
let activeChatSessionId = null;
let activeChatSession = null;
let isCapturingImages = false;
let activeGenerationPageNumber = null;
let activeImageDownload = null;
let isChatGptLoggedIn = false;

function createChatSessionId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function waitForImageDownload(pageNumber) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (activeImageDownload?.timeoutId === timeoutId) activeImageDownload = null;
      reject(new Error(`Timed out downloading image for page ${pageNumber}.`));
    }, 360000);

    activeImageDownload = {
      pageNumber,
      timeoutId,
      resolve: (filePath) => {
        clearTimeout(timeoutId);
        activeImageDownload = null;
        resolve(filePath);
      },
    };
  });
}

function cancelImageDownloadWait() {
  if (!activeImageDownload) return;
  clearTimeout(activeImageDownload.timeoutId);
  activeImageDownload = null;
}

function extractGeneratedImageUrls(value) {
  if (typeof value !== 'string') return [];
  const matches = value.match(/https?:\/\/[^\s"'<>\\]+\/backend-api\/estuary\/content\?[^\s"'<>\\]+/gi) || [];
  return [...new Set(matches.map((url) => url.replace(/[),.]+$/, '')))];
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
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const isAppUrl = app.isPackaged ? url.startsWith('app://') : url.startsWith('http://localhost:3000');
    if (!isAppUrl) {
      event.preventDefault();
      void shell.openExternal(url);
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

function getImageGenerationPayload(userText) {
  try {
    const payload = JSON.parse(userText);
    if (payload && ['start', 'continue'].includes(payload.status)) return payload;
  } catch {
    // Text prompts are expected to be plain text, not JSON image requests.
  }
  return null;
}

// Setup Local JSON Storage in User Data Folder
const dataFilePath = path.join(app.getPath('userData'), 'notes_data.json');
const imagesDir = path.join(app.getPath('userData'), 'images');

if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

async function readDataFileAsync() {
  try {
    if (fs.existsSync(dataFilePath)) {
      const rawData = await fs.promises.readFile(dataFilePath, 'utf-8');
      const parsed = JSON.parse(rawData);
      return {
        notes_collection: Array.isArray(parsed.notes_collection) ? parsed.notes_collection : [],
        image_records: Array.isArray(parsed.image_records) ? parsed.image_records : []
      };
    }
  } catch (err) {
    console.error('Failed to read local JSON data file:', err);
  }
  return { notes_collection: [], image_records: [] };
}

async function writeDataFileAsync(data) {
  try {
    await fs.promises.writeFile(dataFilePath, JSON.stringify(data, null, 2), 'utf-8');
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
  if (typeof value !== 'string') return '';
  if (!value.startsWith('local://')) return value;

  const decoded = decodeURI(value.replace(/^local:\/\//, ''));
  if (!decoded) return '';

  try {
    const resolvedPath = path.resolve(decoded);
    const resolvedImagesDir = path.resolve(imagesDir);
    if (!resolvedPath.startsWith(resolvedImagesDir + path.sep) && resolvedPath !== resolvedImagesDir) {
      return '';
    }
    return resolvedPath;
  } catch (err) {
    console.error("Path traversal prevention error:", err);
    return '';
  }
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

async function downloadGeneratedImage(imgUrl) {
  if (!hiddenWorkerWindow || hiddenWorkerWindow.isDestroyed()) return null;

  const urlObj = new URL(imgUrl);
  const fileId = urlObj.searchParams.get('id') || imgUrl;
  if (processedUrls.has(fileId)) return null;
  if (processedUrls.size >= 500) {
    const firstItem = processedUrls.values().next().value;
    if (firstItem) processedUrls.delete(firstItem);
  }
  processedUrls.add(fileId);

  try {
    const base64 = await hiddenWorkerWindow.webContents.executeJavaScript(`
      fetch(${JSON.stringify(imgUrl)})
        .then((response) => {
          if (!response.ok) throw new Error('Image download failed: ' + response.status);
          return response.blob();
        })
        .then(blob => new Promise(res => {
          const reader = new FileReader();
          reader.onloadend = () => res(reader.result);
          reader.readAsDataURL(blob);
        }))
    `);
    if (!base64) return null;

    const base64Data = base64.replace(/^data:image\/\w+;base64,/, "");
    const filePath = path.join(imagesDir, `note_${fileId}_${Date.now()}.png`);
    fs.writeFileSync(filePath, base64Data, 'base64');
    console.log("[ELECTRON] Successfully downloaded and saved image locally to:", filePath);
    await saveRecordToDb({ id: fileId, filePath, timestamp: Date.now() });

    if (mainWindow) {
      mainWindow.webContents.send('new-image', {
        filePath: toLocalImageUrl(filePath),
        pageNumber: activeGenerationPageNumber,
      });
    }
    if (activeImageDownload && activeImageDownload.pageNumber === activeGenerationPageNumber) {
      activeImageDownload.resolve(filePath);
    }
    return filePath;
  } catch (err) {
    processedUrls.delete(fileId);
    console.error("Failed to download image:", err);
    return null;
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
  if (hiddenWorkerWindow && !hiddenWorkerWindow.isDestroyed()) {
    await hiddenWorkerWindow.loadURL('https://chatgpt.com/');
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
  const chatUrl = noteData.chatUrl || (hiddenWorkerWindow ? hiddenWorkerWindow.webContents.getURL() : "");
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
    if (!hiddenWorkerWindow || hiddenWorkerWindow.isDestroyed()) return;
    try {
      const currentUrl = hiddenWorkerWindow.webContents.getURL();
      if (!currentUrl.includes('chatgpt.com')) {
        return;
      }
      const hasLoginText = await hiddenWorkerWindow.webContents.executeJavaScript(`
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
        if (hiddenWorkerWindow && !hiddenWorkerWindow.isVisible()) {
          console.log("[ELECTRON] Showing hidden worker window for login.");
          hiddenWorkerWindow.show();
          hiddenWorkerWindow.focus();
        }
      } else {
        if (hiddenWorkerWindow && !hiddenWorkerWindow.isDestroyed() && hiddenWorkerWindow.isVisible()) {
          hiddenWorkerWindow.hide();
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
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame: false,
    icon: path.join(__dirname, '../app/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      devTools: (!app.isPackaged || forceAllowDevTools),
    }
  });

  hiddenWorkerWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: (!app.isPackaged || forceAllowDevTools),
    },
  });

  disableDevTools(mainWindow);
  disableDevTools(hiddenWorkerWindow);
  openAppLinksExternally(mainWindow);

  // Inject fluxnotes API engine on page load
  hiddenWorkerWindow.webContents.on('did-finish-load', async () => {
    const currentUrl = hiddenWorkerWindow.webContents.getURL();
    if (currentUrl.includes('chatgpt.com') && chatGptEngineScript) {
      try {
        await hiddenWorkerWindow.webContents.executeJavaScript(chatGptEngineScript);
        const hasLoginText = await hiddenWorkerWindow.webContents.executeJavaScript(`
          document.body ? /\\b(Log in|Sign up)\\b/.test(document.body.innerText) : true
        `);
        isChatGptLoggedIn = !hasLoginText;
        console.log("[ELECTRON] fluxnotes Engine injected successfully.");
      } catch (err) {
        console.error("[ELECTRON] Failed to inject fluxnotes engine:", err);
      }
    }
  });

  if (app.isPackaged) {
    await appServe(mainWindow);
    mainWindow.loadURL("app://-");
  } else {
    mainWindow.loadURL("http://localhost:3000");
  }

  await hiddenWorkerWindow.loadURL("https://chatgpt.com/");

  if (forceShowWorker) {
    mainWindow.show();
    hiddenWorkerWindow.show();
    if (forceAllowDevTools) {
      mainWindow.webContents.openDevTools();
      hiddenWorkerWindow.webContents.openDevTools();
    }
  } else {
    startLoginCheckRoutine();
  }

  if (app.isPackaged) {
    autoUpdater.checkForUpdatesAndNotify().catch(err => {
      console.log("Failed to check for updates:", err);
    });
  }

  const existingRecords = await getStoredRecords();
  existingRecords.forEach(rec => processedUrls.add(rec.id));

  hiddenWorkerWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      let isChatGptStylesheet = false;
      try {
        const requestUrl = new URL(details.url);
        const isChatGptAsset = requestUrl.hostname === 'chatgpt.com'
          || requestUrl.hostname.endsWith('.chatgpt.com')
          || requestUrl.hostname.endsWith('.oaistatic.com');
        const looksLikeStylesheet = details.resourceType === 'stylesheet'
          || /\.css(?:$|[?#])/i.test(requestUrl.pathname + requestUrl.search);
        isChatGptStylesheet = isChatGptAsset && looksLikeStylesheet;
      } catch {
        // Non-web schemes (such as devtools://) must remain loadable.
      }
      callback({ cancel: isChatGptStylesheet });
    },
  );

  hiddenWorkerWindow.webContents.session.webRequest.onCompleted({
    urls: ['https://chatgpt.com/backend-api/estuary/content*']
  }, async (details) => {
    if (!isCapturingImages) return;
    console.log("[ELECTRON] Image found! URL:", details.url);
    await downloadGeneratedImage(details.url);
  });
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
  if (!hiddenWorkerWindow) return false;

  const imagePayload = getImageGenerationPayload(userText);

  if (!activeChatSessionId) {
    activeChatSessionId = createChatSessionId();
    activeChatSession = { conversationId: null, parentMessageId: null };
  }

  activeGenerationPageNumber = imagePayload && Number.isFinite(Number(imagePayload.pageNumber))
    ? Number(imagePayload.pageNumber)
    : null;

  if (!imagePayload && pendingChatUrl) {
    const chatUrl = pendingChatUrl;
    pendingChatUrl = null;
    if (hiddenWorkerWindow.webContents.getURL() !== chatUrl) {
      await hiddenWorkerWindow.loadURL(chatUrl);
    }
  }

  try {
    // Every request, including image generation, uses fluxnotes. Image requests
    // additionally watch for an estuary file URL and finish once it is saved.
    const imageDownloaded = imagePayload
      ? waitForImageDownload(activeGenerationPageNumber)
      : null;
    if (imagePayload) {
      isCapturingImages = true;
    }

    let promptContent = "";
    try {
      const promptPath = path.join(__dirname, '../prompt.md');
      if (fs.existsSync(promptPath)) {
        promptContent = fs.readFileSync(promptPath, 'utf-8');
      }
    } catch (error) {
      console.error("Failed to read prompt.md:", error);
    }

    // 1. Ensure fluxnotes Engine is injected
    const isEngineLoaded = await hiddenWorkerWindow.webContents.executeJavaScript(`typeof window.__fluxnotesChatGPT !== 'undefined'`);
    if (!isEngineLoaded && chatGptEngineScript) {
      console.log("[ELECTRON] fluxnotes engine missing. Injecting now...");
      await hiddenWorkerWindow.webContents.executeJavaScript(chatGptEngineScript);
    }

    // The Electron process owns the session. The page never restores a session
    // from localStorage, so a new note cannot accidentally continue an old one.
    const sessionId = activeChatSessionId;
    const session = activeChatSession;
    const fluxnotesImageWatcher = imagePayload
      ? `
        const requestedImageUrls = new Set();
        window.__fluxnotesOnContent = function(content) {
          const urls = String(content).match(/https?:\\/\\/[^\\s"'<>\\\\]+\\/backend-api\\/estuary\\/content\\?[^\\s"'<>\\\\]+/gi) || [];
          urls.forEach((url) => {
            const cleanUrl = url.replace(/[),.]+$/, '');
            if (requestedImageUrls.has(cleanUrl)) return;
            requestedImageUrls.add(cleanUrl);
            fetch(cleanUrl, { credentials: 'include' }).catch(() => {});
          });
        };
      `
      : 'window.__fluxnotesOnContent = null;';
    const result = await hiddenWorkerWindow.webContents.executeJavaScript(`
      (async function() {
        if (!window.__fluxnotesChatGPT) {
          throw new Error("fluxnotes engine not loaded.");
        }

        const sysPrompt = ${JSON.stringify(promptContent)};
        const usrText = ${JSON.stringify(userText)};
        const sessionId = ${JSON.stringify(sessionId)};
        const session = ${JSON.stringify(session)};
        window.__fluxnotesChatGPT.setSession(sessionId, session);
        ${fluxnotesImageWatcher}

        const currentConvoId = window.__fluxnotesChatGPT.getConversationId(sessionId);

        if (!currentConvoId && sysPrompt.trim() !== "") {
          console.log("[INJECTION] Sending initial system prompt to thread...");
          await window.__fluxnotesChatGPT.send(sysPrompt, 'chatgpt', null, sessionId);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log("[INJECTION] Sending user query to the same conversation thread...");
        const finalOutput = await window.__fluxnotesChatGPT.send(usrText, 'chatgpt', null, sessionId);
        const activeConvoId = window.__fluxnotesChatGPT.getConversationId(sessionId);

        return {
          rawText: finalOutput,
          conversationId: activeConvoId,
          session: window.__fluxnotesChatGPT.getSession(sessionId),
        };
      })();
    `);

    if (result) {
      const { rawText = "", conversationId, session } = result;
      activeChatSession = session || activeChatSession;

      if (imagePayload) {
        if (conversationId) {
          const targetChatUrl = `https://chatgpt.com/c/${conversationId}`;
          console.log("[ELECTRON] Reloading generated-image conversation:", targetChatUrl);
          await hiddenWorkerWindow.loadURL(targetChatUrl);
        }

        const generatedImageUrls = extractGeneratedImageUrls(rawText);
        await Promise.all(generatedImageUrls.map(downloadGeneratedImage));
        await imageDownloaded;
        return {
          chatUrl: conversationId ? `https://chatgpt.com/c/${conversationId}` : undefined,
          chatSessionId: sessionId,
          chatSession: activeChatSession,
        };
      }

      if (!rawText) return null;

      // Text responses are rendered once so their chat URL remains available.
      if (conversationId) {
        const targetChatUrl = `https://chatgpt.com/c/${conversationId}`;
        const currentWorkerUrl = hiddenWorkerWindow.webContents.getURL();

        if (currentWorkerUrl !== targetChatUrl) {
          console.log("[ELECTRON] Navigating worker window to active chat thread for image processing:", targetChatUrl);
          await hiddenWorkerWindow.loadURL(targetChatUrl);
          // Give the page a few seconds to render content so webRequest.onCompleted captures assets cleanly
          await new Promise(resolve => setTimeout(resolve, 4000));
        }
      }

      try {
        const jsonText = extractJsonFromResponse(rawText);
        const jsonData = completeNotePayload(JSON.parse(completeTruncatedJson(jsonText)));

        if (conversationId) {
          jsonData.chatUrl = `https://chatgpt.com/c/${conversationId}`;
        }
        jsonData.chatSessionId = sessionId;
        jsonData.chatSession = activeChatSession;

        console.log("[ELECTRON] Successfully processed conversation and images:", jsonData.topicName);
        return jsonData;
      } catch (parseErr) {
        console.error("[ELECTRON] JSON Parse Error:", parseErr.message);
        return { error: "Failed to parse JSON", raw: rawText };
      }
    }
    return null;

  } catch (err) {
    console.error("Failed to execute fluxnotes API script:", err);
    return false;
  }
  finally {
    isCapturingImages = false;
    activeGenerationPageNumber = null;
    cancelImageDownloadWait();
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
