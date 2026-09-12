import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { NoteRecord } from '../types';
import {
  FnFileContent,
  writeFnFile,
  readFnFile,
  CURRENT_SCHEMA_VERSION,
  FN_MAGIC,
} from './fnFormat';
import { getStoredNotes } from './storage';
import { chunkNoteRecord } from '../ai/chunker';
import { reindexTopicEmbeddings, HttpEmbeddingProvider } from '../ai/embeddings';
import { saveNoteImagesToFnd } from './fndStorage';

export function getFnTopicsDir(): string {
  const userDataPath = app?.getPath ? app.getPath('userData') : process.cwd();
  return path.join(userDataPath, 'fn_topics');
}

export function getFnFilePath(topicId: string): string {
  const safeId = topicId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getFnTopicsDir(), `${safeId}.fn`);
}

/**
 * Saves a note to its custom `.fn` binary container and updates RAG index.
 */
export async function saveNoteToFn(note: NoteRecord): Promise<void> {
  const topicId = note.topicId;
  if (!topicId) return;

  const fnPath = getFnFilePath(topicId);
  let existingContent: FnFileContent | null = null;

  if (fs.existsSync(fnPath)) {
    try {
      existingContent = await readFnFile(fnPath);
    } catch (err) {
      console.warn(`[fnStorage] Failed to read existing .fn file at '${fnPath}':`, err);
    }
  }

  const { pages, chunks, relationships, images } = chunkNoteRecord(note);

  const provider = new HttpEmbeddingProvider();
  const embeddings = await reindexTopicEmbeddings(existingContent, chunks, provider);

  const now = Date.now();
  const createdTimestamp = existingContent?.header?.createdTimestamp || note.timestamp || now;

  const fnContent: FnFileContent = {
    header: {
      magic: FN_MAGIC,
      schemaVersion: CURRENT_SCHEMA_VERSION,
      topicUid: topicId,
      createdTimestamp,
      updatedTimestamp: now,
    },
    topic: {
      topicId,
      topicName: note.topicName || 'Untitled Topic',
      chatUrl: note.chatUrl,
      chatSessionId: note.chatSessionId,
      chatSession: note.chatSession,
      pinned: Boolean(note.pinned),
      notesTheme: note.notesTheme,
      createdTimestamp,
      updatedTimestamp: now,
    },
    document: {
      pages,
    },
    assets: {
      images,
    },
    semantic: {
      chunks,
      relationships,
    },
    rag: {
      model: provider.getModelName(),
      dimensions: provider.getDimensions(),
      modality: 'text',
      embeddings,
    },
  };

  await writeFnFile(fnPath, fnContent);

  try {
    await saveNoteImagesToFnd(note);
  } catch (fndErr) {
    console.warn(`[fnStorage] Failed to save note images to .fnd container for '${topicId}':`, fndErr);
  }
}

/**
 * Deletes the `.fn` binary container for a topic.
 */
export async function deleteFnFile(topicId: string): Promise<void> {
  if (!topicId) return;
  const fnPath = getFnFilePath(topicId);
  if (fs.existsSync(fnPath)) {
    try {
      await fs.promises.unlink(fnPath);
    } catch (err) {
      console.error(`[fnStorage] Failed to delete .fn file '${fnPath}':`, err);
    }
  }
}

/**
 * Ensures all existing notes from notes_data.json have a corresponding .fn binary container file.
 */
export async function ensureAllNotesSyncedToFn(): Promise<void> {
  try {
    const notes = await getStoredNotes();
    if (!Array.isArray(notes) || notes.length === 0) return;

    for (const note of notes) {
      if (!note.topicId) continue;
      const fnPath = getFnFilePath(note.topicId);
      if (!fs.existsSync(fnPath)) {
        console.log(`[fnStorage] Syncing existing note '${note.topicName}' (${note.topicId}) to .fn binary container...`);
        await saveNoteToFn(note);
      }
    }
  } catch (err) {
    console.error('[fnStorage] Error syncing existing notes to .fn containers:', err);
  }
}
