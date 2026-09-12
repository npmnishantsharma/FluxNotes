export interface ChatSession {
  conversationId: string | null;
  parentMessageId: string | null;
}

export interface SubTopic {
  names: string[];
  pageNumber: string | number;
}

export interface NoteRecord {
  topicId: string;
  topicName: string;
  subTopics?: SubTopic[];
  aiResponse?: string;
  recommendedResponse?: string[];
  images?: Array<{ filePath: string; pageNumber: number }>;
  chatUrl?: string;
  chatSessionId?: string | null;
  chatSession?: ChatSession | null;
  pinned?: boolean;
  timestamp?: number;
  status?: string;
  messageId?: string;
  generationId?: string;
  fileId?: string;
  generatedImages?: GeneratedImageInfo[];
  notesTheme?: Record<string, unknown>;
}

export interface ImageRecord {
  id: string;
  filePath: string;
  timestamp: number;
  source: string;
  generationId?: string;
  fileId?: string;
  pageNumber?: number;
  sessionId?: string;
}

export interface FailedPage {
  pageNumber: number;
  subTopicNames: string[];
  originalTopic: string;
  sessionId: string;
  errorMessage?: string;
  timestamp: number;
  notesTheme?: Record<string, unknown>;
}

export interface NotesData {
  notes_collection: NoteRecord[];
  image_records: ImageRecord[];
  failed_pages?: FailedPage[];
}

export interface GeneratedImageInfo {
  imagePath?: string;
  fileId?: string;
  generationId?: string;
  download?: {
    base64: string;
    mimeType: string;
    size?: number;
  };
  downloadError?: string;
}

export interface ChatGptResult {
  rawText: string;
  conversationId: string | null;
  messageId: string | null;
  session: ChatSession | null;
  generationId: string | null;
  fileId: string | null;
  generatedImages: GeneratedImageInfo[];
  downloadedSandboxImages: GeneratedImageInfo[];
  generatedAssetImages?: {
    fileId: string;
    mimeType: string;
    size: number;
    downloadUrl: string;
  }[];
}

export type AIProvider = 'chatgpt' | 'gemini';

export interface ExportNoteOptions {
  images: string[];
  topicName: string;
  format: 'pdf' | 'png' | 'jpeg' | 'md';
}

export interface RawResponseData {
  provider: AIProvider;
  sessionId?: string | null;
  timestamp: string;
  rawResponse: string;
  formattedJson?: unknown;
}
