import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { NoteRecord } from '../types';
import {
  FndFileContent,
  FndImageEntry,
  writeFndFile,
  readFndFile,
  FND_MAGIC,
  CURRENT_FND_SCHEMA_VERSION,
} from './fndFormat';
import { fromLocalImageUrl } from './helpers';

export function getFndTopicsDir(): string {
  const userDataPath = app?.getPath ? app.getPath('userData') : process.cwd();
  return path.join(userDataPath, 'fnd_topics');
}

export function getFndFilePath(topicId: string): string {
  const safeId = topicId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(getFndTopicsDir(), `${safeId}.fnd`);
}

/**
 * Saves/packages all note page image files into a single `.fnd` binary container file.
 */
export async function saveNoteImagesToFnd(note: NoteRecord): Promise<void> {
  const topicId = note.topicId;
  if (!topicId || !Array.isArray(note.images) || note.images.length === 0) return;

  const fndPath = getFndFilePath(topicId);
  const now = Date.now();
  const fndImages: FndImageEntry[] = [];

  for (const img of note.images) {
    const rawPath = typeof img === 'string' ? img : img.filePath;
    const pageNum = typeof img === 'string' ? 0 : img.pageNumber;
    const localPath = fromLocalImageUrl(rawPath);

    if (fs.existsSync(localPath)) {
      try {
        const imageBuffer = await fs.promises.readFile(localPath);
        const ext = path.extname(localPath).toLowerCase();
        let mimeType = 'image/png';
        if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
        else if (ext === '.webp') mimeType = 'image/webp';

        fndImages.push({
          id: `page-${pageNum}`,
          pageNumber: pageNum,
          mimeType,
          description: `Note Page ${pageNum}`,
          imageBuffer,
        });
      } catch (err) {
        console.warn(`[fndStorage] Failed to read image at '${localPath}':`, err);
      }
    }
  }

  if (fndImages.length === 0) return;

  const content: FndFileContent = {
    header: {
      magic: FND_MAGIC,
      schemaVersion: CURRENT_FND_SCHEMA_VERSION,
      topicUid: topicId,
      createdTimestamp: note.timestamp || now,
      updatedTimestamp: now,
    },
    images: fndImages,
  };

  await writeFndFile(fndPath, content);
}

/**
 * Extracts a specific page image buffer from a topic's `.fnd` binary container.
 */
export async function getFndImagePage(topicId: string, pageNumber: number): Promise<{ buffer: Buffer; mimeType: string } | null> {
  const fndPath = getFndFilePath(topicId);
  if (!fs.existsSync(fndPath)) return null;

  try {
    const content = await readFndFile(fndPath);
    const entry = content.images.find((img) => img.pageNumber === pageNumber);
    if (!entry) return null;
    return {
      buffer: entry.imageBuffer,
      mimeType: entry.mimeType,
    };
  } catch (err) {
    console.error(`[fndStorage] Failed to read page ${pageNumber} from '${fndPath}':`, err);
    return null;
  }
}
