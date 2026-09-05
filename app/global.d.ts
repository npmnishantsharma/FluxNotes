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
      onNewImage: (callback: (image: string | { filePath: string; pageNumber?: number | null }) => void) => void;
      onProgressUpdate: (callback: (progress: any) => void) => void;
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
    };
  }
}
