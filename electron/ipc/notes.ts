import { ipcMain, dialog, BrowserWindow, nativeImage } from 'electron';
import fs from 'fs';
import path from 'path';
import { NoteRecord, ExportNoteOptions, FailedPage } from '../types';
import {
  getStoredNotes,
  saveNotesCollection,
  getStoredRecords,
  saveImageRecords,
  saveFailedPage,
  getFailedPages,
  removeFailedPage,
  imagesDir,
  resultsDir,
} from '../utils/storage';
import {
  fromLocalImageUrl,
  toLocalImageUrl,
  safeFileName,
  escapeHtml,
} from '../utils/helpers';
import { CHATGPT_URL, GEMINI_SIGN_IN_URL } from '../windows';
import { getLogs, clearLogs } from '../utils/logger';
import { saveNoteToFn, deleteFnFile } from '../utils/fnStorage';

export function registerNotesIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  getWorkerWindow: () => BrowserWindow | null,
  getSelectedProvider: () => Promise<string | null>,
  sessionState: {
    pendingChatUrl: string | null;
    activeChatSessionId: string | null;
    activeChatSession: unknown;
    isGeminiSessionInitialized: boolean;
    createChatSessionId: () => string;
  },
): void {
  ipcMain.handle('get-all-notes', async () => {
    return await getStoredNotes();
  });

  ipcMain.handle('get-note-by-id', async (_, topicId: string) => {
    const notes = await getStoredNotes();
    return notes.find((n) => n.topicId === topicId) || null;
  });

  ipcMain.handle('get-stored-images', async () => {
    const records = await getStoredRecords();
    return records
      .filter((rec) => fs.existsSync(rec.filePath))
      .map((rec) => toLocalImageUrl(rec.filePath));
  });

  ipcMain.handle('start-new-chat', async () => {
    sessionState.pendingChatUrl = null;
    sessionState.activeChatSessionId = sessionState.createChatSessionId();
    sessionState.activeChatSession = { conversationId: null, parentMessageId: null };
    sessionState.isGeminiSessionInitialized = false;

    const workerWindow = getWorkerWindow();
    if (workerWindow && !workerWindow.isDestroyed()) {
      const provider = await getSelectedProvider();
      await workerWindow.loadURL(provider === 'gemini' ? GEMINI_SIGN_IN_URL : CHATGPT_URL);
    }
    return { sessionId: sessionState.activeChatSessionId };
  });

  ipcMain.handle('set-note-chat-session', (_, { chatUrl, sessionId, session }) => {
    sessionState.pendingChatUrl = typeof chatUrl === 'string' && chatUrl.includes('chatgpt.com') ? chatUrl : null;
    sessionState.activeChatSessionId = typeof sessionId === 'string' && sessionId ? sessionId : sessionState.createChatSessionId();
    sessionState.activeChatSession = session && typeof session === 'object'
      ? {
          conversationId: typeof session.conversationId === 'string' ? session.conversationId : null,
          parentMessageId: typeof session.parentMessageId === 'string' ? session.parentMessageId : null,
        }
      : {
          conversationId: sessionState.pendingChatUrl ? sessionState.pendingChatUrl.match(/\/c\/([^/?#]+)/)?.[1] || null : null,
          parentMessageId: null,
        };
    sessionState.isGeminiSessionInitialized = true;
    return true;
  });

  ipcMain.handle('save-note', async (_, noteData: NoteRecord) => {
    const notes = await getStoredNotes();
    const worker = getWorkerWindow();
    const chatUrl = noteData.chatUrl || (worker ? worker.webContents.getURL() : '');

    // Handle images with page numbers
    const savedImages = Array.isArray(noteData.images)
      ? noteData.images
        .map((image) => {
          // Handle both old format (string) and new format (object with filePath and pageNumber)
          const imagePath = typeof image === 'string' ? image : image.filePath;
          const pageNumber = typeof image === 'string' ? 0 : image.pageNumber;
          const localPath = typeof imagePath === 'string' ? fromLocalImageUrl(imagePath) : '';

          if (!localPath.startsWith(imagesDir) || !fs.existsSync(localPath)) {
            return null;
          }

          return {
            filePath: toLocalImageUrl(localPath),
            pageNumber: pageNumber || 0,
          };
        })
        .filter((image): image is { filePath: string; pageNumber: number } => image !== null)
      : [];

    const fullNoteRecord: NoteRecord = {
      ...noteData,
      images: savedImages,
      chatUrl,
      chatSessionId: noteData.chatSessionId || sessionState.activeChatSessionId || null,
      chatSession: noteData.chatSession || (sessionState.activeChatSession as NoteRecord['chatSession']) || null,
      timestamp: Date.now(),
    };

    const existingIndex = notes.findIndex((n) => n.topicId === noteData.topicId);
    if (existingIndex >= 0) {
      notes[existingIndex] = { ...notes[existingIndex], ...fullNoteRecord };
    } else {
      notes.push(fullNoteRecord);
    }

    await saveNotesCollection(notes);

    try {
      await saveNoteToFn(fullNoteRecord);
    } catch (fnErr) {
      console.warn('[save-note] Failed to write .fn binary file:', fnErr);
    }

    return true;
  });

  ipcMain.handle('rename-note', async (_, { topicId, topicName }: { topicId: string; topicName: string }) => {
    const name = typeof topicName === 'string' ? topicName.trim() : '';
    if (!name) return { success: false, error: 'A note name is required.' };

    const notes = await getStoredNotes();
    const index = notes.findIndex((note) => note.topicId === topicId);
    if (index === -1) return { success: false, error: 'Note not found.' };

    notes[index] = { ...notes[index], topicName: name };
    await saveNotesCollection(notes);
    return { success: true };
  });

  ipcMain.handle('set-note-pinned', async (_, { topicId, pinned }: { topicId: string; pinned: boolean }) => {
    const notes = await getStoredNotes();
    const index = notes.findIndex((note) => note.topicId === topicId);
    if (index === -1) return { success: false, error: 'Note not found.' };

    notes[index] = { ...notes[index], pinned: Boolean(pinned) };
    await saveNotesCollection(notes);
    return { success: true };
  });

  ipcMain.handle('delete-note', async (_, topicId: string) => {
    const notes = await getStoredNotes();
    const noteToDelete = notes.find((note) => note.topicId === topicId);
    if (!noteToDelete) return { success: false, error: 'Note not found.' };

    const remainingNotes = notes.filter((note) => note.topicId !== topicId);
    const remainingImagePaths = new Set(remainingNotes.flatMap((note) => (
      Array.isArray(note.images)
        ? note.images.map((image) => typeof image === 'string' ? fromLocalImageUrl(image) : fromLocalImageUrl(image.filePath))
        : []
    )));
    const removableImagePaths = (noteToDelete.images || [])
      .map((image) => typeof image === 'string' ? fromLocalImageUrl(image) : fromLocalImageUrl(image.filePath))
      .filter((imagePath) => imagePath.startsWith(imagesDir) && !remainingImagePaths.has(imagePath));

    await Promise.all(removableImagePaths.map(async (imagePath) => {
      try {
        await fs.promises.unlink(imagePath);
      } catch (error) {
        const err = error as NodeJS.ErrnoException;
        if (err.code !== 'ENOENT') throw error;
      }
    }));
    await saveNotesCollection(remainingNotes);

    const removedPaths = new Set(removableImagePaths);
    const records = await getStoredRecords();
    await saveImageRecords(records.filter((record) => !removedPaths.has(record.filePath)));

    try {
      await deleteFnFile(topicId);
    } catch (fnErr) {
      console.warn('[delete-note] Failed to delete .fn binary file:', fnErr);
    }

    return { success: true };
  });

  ipcMain.handle('export-note', async (_, { images, topicName, format }: ExportNoteOptions) => {
    const mainWindow = getMainWindow();
    const imagePaths = Array.isArray(images)
      ? images.map((imagePath) => typeof imagePath === 'string' ? fromLocalImageUrl(imagePath) : '')
        .filter((imagePath) => fs.existsSync(imagePath))
      : [];

    if (imagePaths.length === 0) {
      return { success: false, error: 'There are no generated pages to export.' };
    }

    const fileName = safeFileName(topicName);

    if (format === 'pdf') {
      if (!mainWindow) return { success: false, error: 'Main window unavailable.' };
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Export notes as PDF',
        defaultPath: `${fileName}.pdf`,
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      });
      if (canceled || !filePath) return { success: false, canceled: true };

      const printWindow = new BrowserWindow({ show: false, webPreferences: { sandbox: true, devTools: false } });
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
      if (!mainWindow) return { success: false, error: 'Main window unavailable.' };
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

  ipcMain.handle('save-raw-result', async (_, { sessionId, rawContent, conversationId }: { sessionId?: string; rawContent: string; conversationId?: string }) => {
    try {
      const safeId = (sessionId || 'default').replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
      const resultFilePath = path.join(resultsDir, `result-${safeId}.json`);
      const fileData = {
        sessionId,
        conversationId: conversationId || null,
        timestamp: Date.now(),
        rawResponse: rawContent,
      };
      await fs.promises.writeFile(resultFilePath, JSON.stringify(fileData, null, 2), 'utf-8');
      console.log('[ELECTRON] Raw result saved to:', resultFilePath);
      return { success: true };
    } catch (err) {
      const error = err as Error;
      console.error('Failed to save raw result file:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('save-failed-page', async (_, failedPage: FailedPage) => {
    try {
      await saveFailedPage(failedPage);
      console.log('[ELECTRON] Failed page saved:', failedPage.pageNumber);
      return { success: true };
    } catch (err) {
      const error = err as Error;
      console.error('Failed to save failed page:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-failed-pages', async () => {
    try {
      const failedPages = await getFailedPages();
      return { success: true, failedPages };
    } catch (err) {
      const error = err as Error;
      console.error('Failed to get failed pages:', error);
      return { success: false, error: error.message, failedPages: [] };
    }
  });

  ipcMain.handle('remove-failed-page', async (_, pageNumber: number, sessionId: string) => {
    try {
      await removeFailedPage(pageNumber, sessionId);
      console.log('[ELECTRON] Failed page removed:', pageNumber);
      return { success: true };
    } catch (err) {
      const error = err as Error;
      console.error('Failed to remove failed page:', error);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle('get-logs', async () => {
    try {
      const logs = getLogs();
      return { success: true, logs };
    } catch (err) {
      const error = err as Error;
      console.error('Failed to get logs:', error);
      return { success: false, error: error.message, logs: '' };
    }
  });

  ipcMain.handle('clear-logs', async () => {
    try {
      clearLogs();
      console.log('[ELECTRON] Logs cleared');
      return { success: true };
    } catch (err) {
      const error = err as Error;
      console.error('Failed to clear logs:', error);
      return { success: false, error: error.message };
    }
  });
}
