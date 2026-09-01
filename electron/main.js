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
let monitorWorkerWindow;
let processedUrls = new Set();
let pendingChatUrl = null;
let activeChatSessionId = null;
let activeChatSession = null;
let isCapturingImages = false;
let activeGenerationPageNumber = null;
let activeImageDownload = null;
let isChatGptLoggedIn = false;
let progressPollingInterval = null;
let progressReloadTimeout = null;

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

function getImageGenerationPayload(userText) {
  try {
    const payload = JSON.parse(userText);
    if (payload && ['start', 'continue'].includes(payload.status)) return payload;
  } catch {
    // Text prompts are expected to be plain text, not JSON image requests.
  }
  return null;
}

function stopProgressPolling() {
  if (progressPollingInterval) {
    clearInterval(progressPollingInterval);
    progressPollingInterval = null;
  }
  if (progressReloadTimeout) {
    clearTimeout(progressReloadTimeout);
    progressReloadTimeout = null;
  }
}

async function extractAndLogProgress() {
  if (!monitorWorkerWindow || monitorWorkerWindow.isDestroyed()) return null;

  try {
    const progressTexts = await monitorWorkerWindow.webContents.executeJavaScript(`
      (function() {
        const results = [];
        const airaElements = document.querySelectorAll('[aira-progress]');
        airaElements.forEach((el) => {
          const attrVal = el.getAttribute('aira-progress');
          const text = el.innerText || el.textContent || '';
          results.push({
            attribute: attrVal,
            text: text.trim()
          });
        });
        const ariaElements = document.querySelectorAll('[aria-progress]');
        ariaElements.forEach((el) => {
          const attrVal = el.getAttribute('aria-progress');
          const text = el.innerText || el.textContent || '';
          results.push({
            attribute: attrVal,
            text: text.trim()
          });
        });
        return results;
      })();
    `);

    if (Array.isArray(progressTexts) && progressTexts.length > 0) {
      const combinedProgress = progressTexts
        .map((p) => (p.attribute ? `${p.attribute}${p.text ? ` - ${p.text}` : ''}` : p.text))
        .filter(Boolean)
        .join(' | ');

      if (combinedProgress) {
        console.log(`[PROGRESS] ${combinedProgress}`);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('image-progress-update', combinedProgress);
        }
        return combinedProgress;
      }
    }

    const fallbackText = await monitorWorkerWindow.webContents.executeJavaScript(`
      (function() {
        const allElements = document.querySelectorAll('*');
        let found = [];
        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i];
          const attrs = el.attributes;
          for (let j = 0; j < attrs.length; j++) {
            const attr = attrs[j];
            if (attr.name.toLowerCase().includes('progress')) {
              const text = (el.innerText || el.textContent || '').trim();
              found.push(attr.name + '="' + attr.value + '"' + (text ? ': ' + text : ''));
            }
          }
        }
        return found.slice(0, 5).join(' || ');
      })();
    `);

    if (fallbackText) {
      console.log(`[PROGRESS] ${fallbackText}`);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('image-progress-update', fallbackText);
      }
      return fallbackText;
    }

    return null;
  } catch (err) {
    console.error('[PROGRESS] Failed to extract progress:', err.message);
    return null;
  }
}

function startProgressPolling(intervalMs = 2000) {
  stopProgressPolling();
  void extractAndLogProgress();
  progressPollingInterval = setInterval(() => {
    void extractAndLogProgress();
  }, intervalMs);
}

async function reloadAndTrackProgress() {
  if (!monitorWorkerWindow || monitorWorkerWindow.isDestroyed()) return;

  stopProgressPolling();

  console.log('[PROGRESS] 10s elapsed. Reloading monitor window to track progress...');
  const currentUrl = monitorWorkerWindow.webContents.getURL();

  try {
    await monitorWorkerWindow.loadURL(currentUrl);
    console.log('[PROGRESS] Monitor window reloaded. Waiting 3s for page render...');
    await new Promise((resolve) => setTimeout(resolve, 3000));
    console.log('[PROGRESS] Starting progress polling (every 2s)...');
    startProgressPolling(2000);
  } catch (err) {
    console.error('[PROGRESS] Failed to reload monitor window:', err.message);
  }
}

// Setup Local JSON Storage in User Data Folder
const dataFilePath = path.join(app.getPath('userData'), 'notes_data.json');
const imagesDir = path.join(app.getPath('userData'), 'images');

// Security helper: Validate path prevents directory traversal
function isSafePath(inputPath, baseDir) {
  const resolvedPath = path.resolve(inputPath);
  const resolvedBase = path.resolve(baseDir);
  return resolvedPath.startsWith(resolvedBase + path.sep) || resolvedPath === resolvedBase;
}

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

async function downloadGeneratedImage(imgUrl) {
  if (!sendWorkerWindow || sendWorkerWindow.isDestroyed()) return null;

  const urlObj = new URL(imgUrl);
  const fileId = urlObj.searchParams.get('id') || imgUrl;
  if (processedUrls.has(fileId)) return null;
  if (processedUrls.size >= 500) {
    const firstItem = processedUrls.values().next().value;
    if (firstItem) processedUrls.delete(firstItem);
  }
  processedUrls.add(fileId);

  try {
    const base64 = await sendWorkerWindow.webContents.executeJavaScript(`
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
  if (sendWorkerWindow && !sendWorkerWindow.isDestroyed()) {
    await sendWorkerWindow.loadURL('https://chatgpt.com/');
  }
  if (monitorWorkerWindow && !monitorWorkerWindow.isDestroyed()) {
    void monitorWorkerWindow.loadURL('https://chatgpt.com/');
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
      .filter((imagePath) => isSafePath(imagePath, imagesDir) && fs.existsSync(imagePath))
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
    .filter((imagePath) => isSafePath(imagePath, imagesDir) && !remainingImagePaths.has(imagePath));

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
        if (monitorWorkerWindow && !monitorWorkerWindow.isDestroyed() && monitorWorkerWindow.isVisible()) {
          monitorWorkerWindow.hide();
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

  monitorWorkerWindow = new BrowserWindow({
    width: 800,
    height: 600,
    show: false,
    frame:false,
    icon: appIconPath,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      devTools: (!app.isPackaged || forceAllowDevTools),
    },
  });

  disableDevTools(mainWindow);
  disableDevTools(sendWorkerWindow);
  disableDevTools(monitorWorkerWindow);

  // Apply external link protection to ALL windows so no webviews accidentally navigate away internally
  openAppLinksExternally(mainWindow);
  openAppLinksExternally(sendWorkerWindow);
  openAppLinksExternally(monitorWorkerWindow);

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

  function shouldStripChatGptResource(details) {
    return false;
    // try {
    //   const requestUrl = new URL(details.url);
    //   const isChatGpt = requestUrl.hostname === 'chatgpt.com'
    //     || requestUrl.hostname.endsWith('.chatgpt.com')
    //     || requestUrl.hostname.endsWith('.oaistatic.com');
    //   if (!isChatGpt) return false;

    //   // If the user is not logged in or is on an auth page, never strip CSS/stylesheets
    //   if (!isChatGptLoggedIn || requestUrl.pathname.includes('/auth') || requestUrl.pathname.includes('/login')) {
    //     return false;
    //   }

    //   const resourceType = (details.resourceType || '').toLowerCase();
    //   const pathname = requestUrl.pathname + requestUrl.search;

    //   const isStylesheet = resourceType === 'stylesheet' || /\.css(?:$|[?#])/i.test(pathname);
    //   const isFont = resourceType === 'font' || /\.(?:woff2?|ttf|otf|eot)(?:$|[?#])/i.test(pathname);
    //   const isImage = resourceType === 'image' || /\.(?:png|jpe?g|gif|webp|svg|ico)(?:$|[?#])/i.test(pathname);
    //   const isMedia = resourceType === 'media' || resourceType === 'video' || resourceType === 'audio';
    //   const isScriptTailwindy = resourceType === 'script' && (/tailwind/i.test(pathname) || /cdn/i.test(pathname));
    //   const isOtherFat = resourceType === 'other' && (/\.(?:css|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3)(?:$|[?#])/i.test(pathname));

    //   const isApi = requestUrl.pathname.startsWith('/backend-api/')
    //     || requestUrl.pathname.startsWith('/api/')
    //     || requestUrl.pathname === '/'
    //     || /\/c\/[^/?#]+/.test(requestUrl.pathname);
    //   const isDynamic = ['xhr', 'fetch', 'document', 'main_frame', 'sub_frame', 'websocket', 'script'].includes(resourceType) && !isScriptTailwindy;
    //   if (isApi || isDynamic) return false;

    //   return isStylesheet || isFont || isImage || isMedia || isScriptTailwindy || isOtherFat;
    // } catch {
    //   return false;
    // }
  }

  monitorWorkerWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      let cancel = false;
      try {
        const requestUrl = new URL(details.url);
        const isChatGptAsset = requestUrl.hostname === 'chatgpt.com'
          || requestUrl.hostname.endsWith('.chatgpt.com')
          || requestUrl.hostname.endsWith('.oaistatic.com');
        if (isChatGptAsset) {
          cancel = false;
        }
      } catch {}
      callback({ cancel });
    },
  );

  sendWorkerWindow.webContents.session.webRequest.onBeforeRequest(
    { urls: ['<all_urls>'] },
    (details, callback) => {
      let cancel = false;
      try {
        const requestUrl = new URL(details.url);
        const isChatGptAsset = requestUrl.hostname === 'chatgpt.com'
          || requestUrl.hostname.endsWith('.chatgpt.com')
          || requestUrl.hostname.endsWith('.oaistatic.com');
        const looksLikeStylesheet = (details.resourceType === 'stylesheet')
          || /\.css(?:$|[?#])/i.test(requestUrl.pathname + requestUrl.search);
        cancel = false;
      } catch {}
      callback({ cancel });
    },
  );

  sendWorkerWindow.webContents.session.webRequest.onCompleted({
    urls: ['https://chatgpt.com/backend-api/estuary/content*']
  }, async (details) => {
    if (!isCapturingImages) return;
    console.log("[ELECTRON] Image found! URL:", details.url);
    await downloadGeneratedImage(details.url);
  });

  if (app.isPackaged) {
    await appServe(mainWindow);
    mainWindow.loadURL("app://-");
  } else {
    mainWindow.loadURL("http://localhost:3000");
  }

  await sendWorkerWindow.loadURL("https://chatgpt.com/");
  void monitorWorkerWindow.loadURL("https://chatgpt.com/");

  if (forceShowWorker) {
    mainWindow.show();
    sendWorkerWindow.show();
    monitorWorkerWindow.show();
    if (forceAllowDevTools) {
      mainWindow.webContents.openDevTools();
      sendWorkerWindow.webContents.openDevTools();
      monitorWorkerWindow.webContents.openDevTools();
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
    if (sendWorkerWindow.webContents.getURL() !== chatUrl) {
      await sendWorkerWindow.loadURL(chatUrl);
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
      stopProgressPolling();
      console.log('[PROGRESS] Image generation request dispatched. Starting 10s timer NOW (will not disturb send).');

      // Kick off the progress timeline immediately, in parallel with the send.
      // After 10s we reload the *monitor* worker (never the send worker), so
      // the streaming send in sendWorkerWindow remains completely undisturbed.
      progressReloadTimeout = setTimeout(() => {
        void reloadAndTrackProgress();
      }, 10000);
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
    const isEngineLoaded = await sendWorkerWindow.webContents.executeJavaScript(`typeof window.__fluxnotesChatGPT !== 'undefined'`);
    if (!isEngineLoaded && chatGptEngineScript) {
      console.log("[ELECTRON] fluxnotes engine missing. Injecting now...");
      await sendWorkerWindow.webContents.executeJavaScript(chatGptEngineScript);
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
        ${fluxnotesImageWatcher}

        const currentConvoId = window.__fluxnotesChatGPT.getConversationId(sessionId);

        if (!currentConvoId && sysPrompt.trim() !== "") {
          console.log("[INJECTION] Sending initial system prompt to thread...");
          await window.__fluxnotesChatGPT.send(sysPrompt, 'chatgpt', null, sessionId);
          await new Promise(resolve => setTimeout(resolve, 2000));
        }

        console.log("[INJECTION] Sending user query to the same conversation thread...");
        const finalOutput = await window.__fluxnotesChatGPT.send(usrText, 'chatgpt', null, sessionId);
        const activeConvoId = finalOutput.conversationId || window.__fluxnotesChatGPT.getConversationId(sessionId);
        const useMessageId = finalOutput.messageId || null;
        console.log(finalOutput);

        const generatedImages = Array.isArray(finalOutput.generatedImages) ? finalOutput.generatedImages : [];
        const sandboxDownloads = [];
        for (let gi = 0; gi < generatedImages.length; gi++) {
          const img = generatedImages[gi];
          if (img && img.imagePath && useMessageId && typeof window.__fluxnotesChatGPT.downloadSandboxImage === 'function') {
            sandboxDownloads.push(
              window.__fluxnotesChatGPT.downloadSandboxImage(img.imagePath, useMessageId, sessionId)
                .then((d) => ({ ...img, download: d }))
                .catch((e) => ({ ...img, downloadError: String(e && e.message || e) }))
            );
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
          generatedImages: generatedImages,
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
          const recordId = img.fileId || fileId || generationId || messageId || `sandbox_${Date.now()}`;
          const filePath = path.join(imagesDir, `note_sandbox_${safeFileName(String(img.fileId || String(img.download.imagePath || recordId)).slice(0, 40))}_${Date.now()}.${safeExt}`);
          try {
            fs.writeFileSync(filePath, base64Data, 'base64');
            console.log("[ELECTRON] Sandbox image saved locally:", filePath);
            await saveRecordToDb({ id: recordId, filePath, timestamp: Date.now(), source: 'sandbox', generationId: img.generationId || generationId, fileId: img.fileId || fileId });
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('new-image', { filePath: toLocalImageUrl(filePath), pageNumber: activeGenerationPageNumber });
            }
            if (activeImageDownload && activeImageDownload.pageNumber === activeGenerationPageNumber) {
              activeImageDownload.resolve(filePath);
            }
          } catch (saveErr) {
            console.error("[ELECTRON] Failed to save sandbox image locally:", saveErr.message);
          }
        }
      }

      if (imagePayload) {
        if (conversationId) {
          const targetChatUrl = `https://chatgpt.com/c/${conversationId}`;
          console.log("[ELECTRON] Syncing sendWorker to conversation:", targetChatUrl);
          await sendWorkerWindow.loadURL(targetChatUrl);
          if (monitorWorkerWindow && !monitorWorkerWindow.isDestroyed()) {
            void monitorWorkerWindow.loadURL(targetChatUrl).catch(() => {});
          }
        }

        const generatedImageUrls = extractGeneratedImageUrls(rawText);
        void Promise.all(generatedImageUrls.map(downloadGeneratedImage));

        try {
          await imageDownloaded;
        } finally {
          stopProgressPolling();
        }
        return {
          chatUrl: conversationId ? `https://chatgpt.com/c/${conversationId}` : undefined,
          chatSessionId: sessionId,
          chatSession: activeChatSession,
          messageId: messageId,
          generationId: generationId,
          fileId: fileId,
          generatedImages: generatedImages,
        };
      }

      if (!rawText) return null;

      // Text responses are rendered once so their chat URL remains available.
      if (conversationId) {
        const targetChatUrl = `https://chatgpt.com/c/${conversationId}`;
        const currentWorkerUrl = sendWorkerWindow.webContents.getURL();

        if (currentWorkerUrl !== targetChatUrl) {
          console.log("[ELECTRON] Navigating sendWorker to active chat thread:", targetChatUrl);
          await sendWorkerWindow.loadURL(targetChatUrl);
          if (monitorWorkerWindow && !monitorWorkerWindow.isDestroyed()) {
            void monitorWorkerWindow.loadURL(targetChatUrl).catch(() => {});
          }
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
  finally {
    isCapturingImages = false;
    activeGenerationPageNumber = null;
    cancelImageDownloadWait();
    stopProgressPolling();
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
    // Prevent arbitrary file reading by strictly validating path scope
    if (!isSafePath(decodedPath, imagesDir)) {
      console.warn(`[SECURITY] Blocked local file inclusion attempt: ${decodedPath}`);
      return callback({ error: -2 }); // -2 is net::ERR_FAILED
    }
    callback({ path: decodedPath });
  });

  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
