import { contextBridge, ipcRenderer } from 'electron';
import { NoteRecord, ExportNoteOptions } from './types';

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('window-minimize'),
  maximize: () => ipcRenderer.send('window-maximize'),
  close: () => ipcRenderer.send('window-close'),
  startNewChat: () => ipcRenderer.invoke('start-new-chat'),
  setNoteChatSession: (chat: { chatUrl?: string; sessionId?: string; session?: unknown }) => ipcRenderer.invoke('set-note-chat-session', chat),
  fillChatGptInput: (text: string, attachments?: { base64: string; filename: string; mimeType: string; fileSize: number }[] | null) => ipcRenderer.invoke('fill-chatgpt-input', text, attachments),
  getStoredImages: () => ipcRenderer.invoke('get-stored-images'),
  getAllNotes: () => ipcRenderer.invoke('get-all-notes'),
  getNoteById: (topicId: string) => ipcRenderer.invoke('get-note-by-id', topicId),
  saveNote: (note: NoteRecord) => ipcRenderer.invoke('save-note', note),
  renameNote: (topicId: string, topicName: string) => ipcRenderer.invoke('rename-note', { topicId, topicName }),
  setNotePinned: (topicId: string, pinned: boolean) => ipcRenderer.invoke('set-note-pinned', { topicId, pinned }),
  deleteNote: (topicId: string) => ipcRenderer.invoke('delete-note', topicId),
  exportNote: (note: ExportNoteOptions) => ipcRenderer.invoke('export-note', note),
  onNewImage: (callback: (data: string | { filePath: string; pageNumber: number | null }) => void) => {
    ipcRenderer.removeAllListeners('new-image');
    ipcRenderer.on('new-image', (_event, value) => callback(value));
  },
  onProgressUpdate: (callback: (progress: string) => void) => {
    ipcRenderer.removeAllListeners('image-progress-update');
    ipcRenderer.on('image-progress-update', (_event, val) => callback(val));
  },
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  restartAndInstall: () => ipcRenderer.send('restart-to-update'),
  onUpdaterEvent: (callback: (eventData: unknown) => void) => {
    ipcRenderer.removeAllListeners('updater-event');
    ipcRenderer.on('updater-event', (_event, data) => callback(data));
  },
  saveRawResult: (data: { sessionId?: string; rawContent: string; conversationId?: string }) => ipcRenderer.invoke('save-raw-result', data),
  getNgrokSettings: () => ipcRenderer.invoke('get-ngrok-settings'),
  configureNgrok: (token: string, port: number, domain: string) => ipcRenderer.invoke('configure-ngrok', token, port, domain),
});
