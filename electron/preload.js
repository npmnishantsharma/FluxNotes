"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('electronAPI', {
    minimize: () => electron_1.ipcRenderer.send('window-minimize'),
    maximize: () => electron_1.ipcRenderer.send('window-maximize'),
    close: () => electron_1.ipcRenderer.send('window-close'),
    startNewChat: () => electron_1.ipcRenderer.invoke('start-new-chat'),
    setNoteChatSession: (chat) => electron_1.ipcRenderer.invoke('set-note-chat-session', chat),
    fillChatGptInput: (text, attachments) => electron_1.ipcRenderer.invoke('fill-chatgpt-input', text, attachments),
    getStoredImages: () => electron_1.ipcRenderer.invoke('get-stored-images'),
    getAllNotes: () => electron_1.ipcRenderer.invoke('get-all-notes'),
    getNoteById: (topicId) => electron_1.ipcRenderer.invoke('get-note-by-id', topicId),
    saveNote: (note) => electron_1.ipcRenderer.invoke('save-note', note),
    renameNote: (topicId, topicName) => electron_1.ipcRenderer.invoke('rename-note', { topicId, topicName }),
    setNotePinned: (topicId, pinned) => electron_1.ipcRenderer.invoke('set-note-pinned', { topicId, pinned }),
    deleteNote: (topicId) => electron_1.ipcRenderer.invoke('delete-note', topicId),
    exportNote: (note) => electron_1.ipcRenderer.invoke('export-note', note),
    onNewImage: (callback) => {
        electron_1.ipcRenderer.removeAllListeners('new-image');
        electron_1.ipcRenderer.on('new-image', (_event, value) => callback(value));
    },
    onProgressUpdate: (callback) => {
        electron_1.ipcRenderer.removeAllListeners('image-progress-update');
        electron_1.ipcRenderer.on('image-progress-update', (_event, val) => callback(val));
    },
    checkForUpdates: () => electron_1.ipcRenderer.invoke('check-for-updates'),
    restartAndInstall: () => electron_1.ipcRenderer.send('restart-to-update'),
    onUpdaterEvent: (callback) => {
        electron_1.ipcRenderer.removeAllListeners('updater-event');
        electron_1.ipcRenderer.on('updater-event', (_event, data) => callback(data));
    },
    saveRawResult: (data) => electron_1.ipcRenderer.invoke('save-raw-result', data),
    getApiToken: () => electron_1.ipcRenderer.invoke('get-api-token'),
    getNgrokSettings: () => electron_1.ipcRenderer.invoke('get-ngrok-settings'),
    configureNgrok: (token, port, domain) => electron_1.ipcRenderer.invoke('configure-ngrok', token, port, domain),
});
