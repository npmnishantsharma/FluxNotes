/* eslint-disable @typescript-eslint/no-explicit-any */
export {};

declare global {
  type ChatAttachment = {
    base64: string;
    filename: string;
    mimeType: string;
    fileSize: number;
  };

  interface Window {
    electronAPI?: {
      minimize: () => void;
      maximize: () => void;
      close: () => void;
      startNewChat: () => Promise<{ sessionId: string }>;
      setNoteChatSession: (chat: { chatUrl?: string; sessionId?: string; session?: { conversationId?: string | null; parentMessageId?: string | null } | null }) => Promise<boolean>;
      fillChatGptInput: (text: string, attachments?: ChatAttachment[] | null) => Promise<any>;
      getStoredImages: () => Promise<string[]>;
      getAllNotes: () => Promise<any[]>;
      getNoteById: (topicId: string) => Promise<any>;
      onNewImage: (callback: (data: string | { filePath: string; pageNumber: number | null }) => void) => void;
      onImageGenerationFailed: (callback: (data: { pageNumber: number; errorMessage: string; subTopicNames: string[] }) => void) => void;
      onProgressUpdate: (callback: (progress: string) => void) => void;
      saveNote: (note: any) => Promise<void>;
      renameNote: (topicId: string, topicName: string) => Promise<{ success: boolean; error?: string }>;
      setNotePinned: (topicId: string, pinned: boolean) => Promise<{ success: boolean; error?: string }>;
      deleteNote: (topicId: string) => Promise<{ success: boolean; error?: string }>;
      exportNote: (note: { images: string[]; topicName: string; format: 'pdf' | 'png' | 'jpeg' }) => Promise<{
        success: boolean;
        canceled?: boolean;
        error?: string;
        path?: string;
        count?: number;
      }>;
      checkForUpdates: () => Promise<any>;
      restartAndInstall: () => void;
      onUpdaterEvent: (callback: (data: { type: string; info?: any; progress?: number }) => void) => void;
      getApiToken: () => Promise<string>;
      getNgrokSettings: () => Promise<{ configured: boolean; active: boolean; url: string | null; port: number; domain: string }>;
      configureNgrok: (token: string, port: number, domain: string) => Promise<{ success: boolean; error?: string; configured?: boolean; active?: boolean; url?: string | null; port?: number; domain?: string }>;
      syncSessionToServer: (serverUrl: string, password: string) => Promise<{ success: boolean; loggedIn?: boolean; error?: string }>;
      getFailedPages: () => Promise<{ success: boolean; failedPages?: Array<{pageNumber: number; subTopicNames: string[]; originalTopic: string; sessionId: string; errorMessage?: string; timestamp: number}> }>;
      saveFailedPage: (failedPage: {pageNumber: number; subTopicNames: string[]; originalTopic: string; sessionId: string; errorMessage?: string; timestamp: number, notesTheme?: Record<string, unknown> | undefined}) => Promise<{ success: boolean }>;
      removeFailedPage: (pageNumber: number, sessionId: string) => Promise<{ success: boolean }>;
      getLogs: () => Promise<{ success: boolean; logs?: string; error?: string }>;
      clearLogs: () => Promise<{ success: boolean; error?: string }>;
      convertLocalImageToBase64: (filePath: string) => Promise<{ success: boolean; base64?: string; mimeType?: string; error?: string }>;
      fnInspector?: {
        list: () => Promise<Array<{ uid: string; fileName: string; filePath: string; topicName: string; fileSize: number; updatedTimestamp: number }>>;
        inspect: (topicUid: string) => Promise<any>;
        getPage: (topicUid: string, pageNumber: number) => Promise<any>;
        getChunks: (topicUid: string) => Promise<any[]>;
        getEmbedding: (topicUid: string, chunkId: string) => Promise<any>;
        getRelationships: (topicUid: string) => Promise<any[]>;
        search: (query: string, options?: any) => Promise<{ results: any[]; queryEmbedding: any }>;
        validate: (topicUid: string) => Promise<any>;
        getBinaryInfo: (topicUid: string) => Promise<any>;
      };
    };
  }
}
