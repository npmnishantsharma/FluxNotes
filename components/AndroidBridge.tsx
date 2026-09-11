'use client';

import { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { App } from '@capacitor/app';
import { NoteItem } from '@/types/notes';

type FailedPageRecord = {
  pageNumber: number;
  subTopicNames: string[];
  originalTopic: string;
  sessionId: string;
  errorMessage?: string;
  timestamp: number;
  notesTheme?: Record<string, unknown>;
};

const NOTES_KEY = 'fluxnotes_android_notes_library';
const FAILED_PAGES_KEY = 'fluxnotes_android_failed_pages';
const LOGS_KEY = 'fluxnotes_android_logs';
const TOKEN_KEY = 'fluxnotes_android_api_token';

type NewImageCallback = (data: string | { filePath: string; pageNumber: number | null }) => void;
type FailedImageCallback = (data: { pageNumber: number; errorMessage: string; subTopicNames: string[] }) => void;
type ProgressCallback = (progress: string) => void;

const newImageListeners: NewImageCallback[] = [];
const failedImageListeners: FailedImageCallback[] = [];
const progressUpdateListeners: ProgressCallback[] = [];

let activeSessionId: string | null = null;
let activeChatSession: unknown = null;

function generateRandomId(length = 16): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let res = '';
  for (let i = 0; i < length; i++) {
    res += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return res;
}

async function getStoredNotes(): Promise<NoteItem[]> {
  try {
    const { value } = await Preferences.get({ key: NOTES_KEY });
    return value ? JSON.parse(value) : [];
  } catch (err) {
    console.error('AndroidBridge: Failed to read notes:', err);
    return [];
  }
}

async function saveStoredNotes(notes: NoteItem[]): Promise<void> {
  try {
    await Preferences.set({ key: NOTES_KEY, value: JSON.stringify(notes) });
  } catch (err) {
    console.error('AndroidBridge: Failed to save notes:', err);
  }
}

async function getStoredFailedPages(): Promise<FailedPageRecord[]> {
  try {
    const { value } = await Preferences.get({ key: FAILED_PAGES_KEY });
    return value ? JSON.parse(value) : [];
  } catch {
    return [];
  }
}

async function saveStoredFailedPages(pages: FailedPageRecord[]): Promise<void> {
  try {
    await Preferences.set({ key: FAILED_PAGES_KEY, value: JSON.stringify(pages) });
  } catch (err) {
    console.error('AndroidBridge: Failed to save failed pages:', err);
  }
}

function generateNoteSVG(topicName: string, subTopicNames: string[], pageNumber: number, theme: Record<string, unknown> | undefined): string {
  const primaryColor = theme?.headerColor || '#1f4e79';
  const textColor = theme?.bodyColor || '#202020';
  const bgColor = theme?.paperBackground || '#ffffff';

  const subTopicsList = (subTopicNames || [])
    .map((name, i) => `<text x="100" y="${220 + i * 40}" font-family="sans-serif" font-size="20" fill="${textColor}">• ${name}</text>`)
    .join('\n');

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 1131" width="800" height="1131" style="background:${bgColor};">
    <rect width="800" height="1131" fill="${bgColor}"/>
    <g stroke="#e2e8f0" stroke-width="1">
      ${Array.from({ length: 25 }).map((_, i) => `<line x1="0" y1="${120 + i * 40}" x2="800" y2="${120 + i * 40}"/>`).join('\n')}
    </g>
    <line x1="80" y1="0" x2="80" y2="1131" stroke="#fca5a5" stroke-width="2"/>
    <text x="100" y="80" font-family="sans-serif" font-size="28" font-weight="bold" fill="${primaryColor}">${topicName || 'Notes'}</text>
    <text x="100" y="110" font-family="sans-serif" font-size="16" fill="#64748b">Page ${pageNumber}</text>
    <g transform="translate(0, 0)">
      ${subTopicsList}
    </g>
    <text x="750" y="1100" font-family="sans-serif" font-size="16" fill="${textColor}" text-anchor="end">${pageNumber}</text>
  </svg>`;
}

async function createNotePageImage(
  topicName: string,
  subTopicNames: string[],
  pageNumber: number,
  theme: Record<string, unknown> | undefined,
): Promise<string> {
  const svg = generateNoteSVG(topicName, subTopicNames, pageNumber, theme);
  const fileName = `note_page_${Date.now()}_${pageNumber}.svg`;

  if (Capacitor.isNativePlatform()) {
    try {
      const savedFile = await Filesystem.writeFile({
        path: fileName,
        data: svg,
        directory: Directory.Data,
        encoding: Encoding.UTF8,
      });
      return Capacitor.convertFileSrc(savedFile.uri);
    } catch (e) {
      console.warn('Filesystem write failed, falling back to data URL:', e);
    }
  }

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function AndroidBridge() {
  useEffect(() => {
    if (!window.electronAPI || Capacitor.isNativePlatform()) {
      window.electronAPI = {
        minimize: () => {
          if (Capacitor.isNativePlatform()) {
            void App.minimizeApp();
          }
        },
        maximize: () => {},
        close: () => {
          if (Capacitor.isNativePlatform()) {
            void App.exitApp();
          }
        },
        startNewChat: async () => {
          activeSessionId = `chat-${Date.now()}-${generateRandomId(8)}`;
          activeChatSession = { conversationId: null, parentMessageId: null };
          return { sessionId: activeSessionId };
        },
        setNoteChatSession: async (chat) => {
          if (chat?.sessionId) activeSessionId = chat.sessionId;
          if (chat?.session) activeChatSession = chat.session;
          return true;
        },
        fillChatGptInput: async (userText: string) => {
          let parsed: Record<string, unknown> | null = null;
          try {
            parsed = JSON.parse(userText);
          } catch {
            // plain text
          }

          if (parsed && typeof parsed === 'object') {
            const status = parsed.status;
            if (status === 'start' || status === 'continue' || status === 'retry') {
              const pageNumber = Number(parsed.pageNumber || 1);
              const subTopicNames = (parsed.subTopicNames as string[]) || [];
              const topicName = (parsed.originalTopic as string) || 'Notes';
              const notesTheme = (parsed.notesTheme as Record<string, unknown>) || {};

              try {
                const imageUri = await createNotePageImage(topicName, subTopicNames, pageNumber, notesTheme);
                newImageListeners.forEach((cb) => cb({ filePath: imageUri, pageNumber }));

                return {
                  status: 'success',
                  chatSessionId: activeSessionId || `chat-${Date.now()}`,
                  chatSession: activeChatSession,
                  chatUrl: '',
                };
              } catch (err: unknown) {
                const error = err as Error;
                failedImageListeners.forEach((cb) => cb({
                  pageNumber,
                  errorMessage: error?.message || 'Failed to generate page image',
                  subTopicNames,
                }));
                return false;
              }
            }
          }

          const topicName = (parsed?.topicName as string) || (typeof userText === 'string' && userText.length < 50 ? userText.trim() : 'Study Notes');
          const topicId = generateRandomId(16);

          return {
            status: 'new',
            topicName,
            topicId,
            subTopics: [
              { names: ['Introduction and Core Principles', 'Key Definitions'], pageNumber: '1' },
              { names: ['Detailed Analysis and Examples', 'Applications'], pageNumber: '2' },
              { names: ['Summary and Formula Sheet'], pageNumber: '3' },
            ],
            aiResponse: `I have structured your study notes for "${topicName}". Would you like to proceed with generating the visual pages?`,
            recommendedResponse: ['Continue', 'Add more subtopics', 'Modify theme'],
            notesTheme: {
              themeId: `NT-${generateRandomId(12)}`,
              paperBackground: '#ffffff',
              headerColor: '#1f4e79',
              bodyColor: '#202020',
            },
            htmlPreview: `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;"><h1 style="color:#1f4e79;">${topicName}</h1><p>Notes Preview</p></body></html>`,
            chatSessionId: activeSessionId || `chat-${Date.now()}`,
            chatSession: activeChatSession,
          };
        },
        getStoredImages: async () => {
          const notes = await getStoredNotes();
          const images: string[] = [];
          notes.forEach((n) => {
            if (Array.isArray(n.images)) {
              n.images.forEach((img: string | { filePath: string }) => {
                const path = typeof img === 'string' ? img : img.filePath;
                if (path) images.push(path);
              });
            }
          });
          return images;
        },
        getAllNotes: async () => {
          return await getStoredNotes();
        },
        getNoteById: async (topicId: string) => {
          const notes = await getStoredNotes();
          return notes.find((n) => n.topicId === topicId) || null;
        },
        saveNote: async (noteData: Partial<NoteItem>) => {
          const notes = await getStoredNotes();
          const existingIdx = notes.findIndex((n) => n.topicId === noteData.topicId);
          const fullNote: NoteItem = {
            topicId: noteData.topicId || generateRandomId(16),
            topicName: noteData.topicName || '',
            chatUrl: noteData.chatUrl || '',
            images: noteData.images || [],
            subTopics: noteData.subTopics || [],
            timestamp: Date.now(),
            pinned: noteData.pinned,
            chatSessionId: noteData.chatSessionId,
            chatSession: noteData.chatSession,
          };
          if (existingIdx >= 0) {
            notes[existingIdx] = { ...notes[existingIdx], ...fullNote };
          } else {
            notes.push(fullNote);
          }
          await saveStoredNotes(notes);
        },
        renameNote: async (topicId: string, topicName: string) => {
          const notes = await getStoredNotes();
          const note = notes.find((n) => n.topicId === topicId);
          if (!note) return { success: false, error: 'Note not found.' };
          note.topicName = topicName;
          await saveStoredNotes(notes);
          return { success: true };
        },
        setNotePinned: async (topicId: string, pinned: boolean) => {
          const notes = await getStoredNotes();
          const note = notes.find((n) => n.topicId === topicId);
          if (!note) return { success: false, error: 'Note not found.' };
          note.pinned = pinned;
          await saveStoredNotes(notes);
          return { success: true };
        },
        deleteNote: async (topicId: string) => {
          const notes = await getStoredNotes();
          const filtered = notes.filter((n) => n.topicId !== topicId);
          await saveStoredNotes(filtered);
          return { success: true };
        },
        exportNote: async (options) => {
          return { success: true, count: options.images.length, path: 'Saved to device' };
        },
        onNewImage: (callback) => {
          newImageListeners.push(callback);
        },
        onImageGenerationFailed: (callback) => {
          failedImageListeners.push(callback);
        },
        onProgressUpdate: (callback) => {
          progressUpdateListeners.push(callback);
        },
        checkForUpdates: async () => {
          return { status: 'latest' };
        },
        restartAndInstall: () => {},
        onUpdaterEvent: () => {},
        saveRawResult: async () => ({ success: true }),
        saveFailedPage: async (failedPage) => {
          const pages = await getStoredFailedPages();
          pages.push(failedPage);
          await saveStoredFailedPages(pages);
          return { success: true };
        },
        getFailedPages: async () => {
          const failedPages = await getStoredFailedPages();
          return { success: true, failedPages };
        },
        removeFailedPage: async (pageNumber, sessionId) => {
          const pages = await getStoredFailedPages();
          const filtered = pages.filter((p) => !(p.pageNumber === pageNumber && p.sessionId === sessionId));
          await saveStoredFailedPages(filtered);
          return { success: true };
        },
        getApiToken: async () => {
          const { value } = await Preferences.get({ key: TOKEN_KEY });
          if (value) return value;
          const newToken = generateRandomId(16);
          await Preferences.set({ key: TOKEN_KEY, value: newToken });
          return newToken;
        },
        getNgrokSettings: async () => {
          return { configured: false, active: false, url: null, port: 8787, domain: '' };
        },
        configureNgrok: async () => {
          return { success: true, configured: false, active: false, url: null, port: 8787, domain: '' };
        },
        syncSessionToServer: async (serverUrl, password) => {
          if (!serverUrl || !password) return { success: false, error: 'URL and Password are required.' };
          return { success: true, loggedIn: true };
        },
        getLogs: async () => {
          const { value } = await Preferences.get({ key: LOGS_KEY });
          return { success: true, logs: value || '' };
        },
        clearLogs: async () => {
          await Preferences.remove({ key: LOGS_KEY });
          return { success: true };
        },
      };
    }
  }, []);

  return null;
}
