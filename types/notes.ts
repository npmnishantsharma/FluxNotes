export type SubTopic = {
  names: string[];
  pageNumber: string | number;
};

export type NoteItem = {
  topicId: string;
  topicName: string;
  chatUrl: string;
  images: Array<{ filePath: string; pageNumber: number }>;
  subTopics: SubTopic[];
  timestamp: number;
  pinned?: boolean;
  chatSessionId?: string;
  chatSession?: { conversationId?: string | null; parentMessageId?: string | null } | null;
};

export type AssistantData = {
  status?: string;
  topicName?: string;
  topicId?: string;
  themeId?: string;
  subTopics?: SubTopic[];
  aiResponse?: string;
  recommendedResponse?: string[];
  chatUrl?: string;
  chatSessionId?: string;
  chatSession?: { conversationId?: string | null; parentMessageId?: string | null } | null;
  notesTheme?: Record<string, unknown>;
};

export type GeneratedPageImage = {
  pageNumber: number;
  filePath: string;
};

export type ExportFormat = 'pdf' | 'png' | 'jpeg' | 'md';

export type AIProvider = 'chatgpt' | 'gemini';
