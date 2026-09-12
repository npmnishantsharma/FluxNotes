import { contextBridge, ipcRenderer } from 'electron';
import { NoteRecord, ExportNoteOptions, FailedPage } from './types';

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
  onImageGenerationFailed: (callback: (data: { pageNumber: number; errorMessage: string; subTopicNames: string[] }) => void) => {
    ipcRenderer.removeAllListeners('image-generation-failed');
    ipcRenderer.on('image-generation-failed', (_event, value) => callback(value));
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
  saveFailedPage: (failedPage: FailedPage) => ipcRenderer.invoke('save-failed-page', failedPage),
  getFailedPages: () => ipcRenderer.invoke('get-failed-pages'),
  removeFailedPage: (pageNumber: number, sessionId: string) => ipcRenderer.invoke('remove-failed-page', pageNumber, sessionId),
  getApiToken: () => ipcRenderer.invoke('get-api-token'),
  getNgrokSettings: () => ipcRenderer.invoke('get-ngrok-settings'),
  configureNgrok: (token: string, port: number, domain: string) => ipcRenderer.invoke('configure-ngrok', token, port, domain),
  syncSessionToServer: (serverUrl: string, password: string) => ipcRenderer.invoke('sync-session-to-server', serverUrl, password),
  getLogs: () => ipcRenderer.invoke('get-logs'),
  clearLogs: () => ipcRenderer.invoke('clear-logs'),
  convertLocalImageToBase64: (filePath: string) => ipcRenderer.invoke('convert-local-image-to-base64', filePath),
  fnInspector: {
    list: () => ipcRenderer.invoke('fn-list'),
    inspect: (topicUid: string) => ipcRenderer.invoke('fn-inspect', topicUid),
    getPage: (topicUid: string, pageNumber: number) => ipcRenderer.invoke('fn-get-page', topicUid, pageNumber),
    getChunks: (topicUid: string) => ipcRenderer.invoke('fn-get-chunks', topicUid),
    getEmbedding: (topicUid: string, chunkId: string) => ipcRenderer.invoke('fn-get-embedding', topicUid, chunkId),
    getRelationships: (topicUid: string) => ipcRenderer.invoke('fn-get-relationships', topicUid),
    search: (query: string, options?: unknown) => ipcRenderer.invoke('fn-search', query, options),
    validate: (topicUid: string) => ipcRenderer.invoke('fn-validate', topicUid),
    getBinaryInfo: (topicUid: string) => ipcRenderer.invoke('fn-get-binary-info', topicUid),
  },
});
