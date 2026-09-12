import { ipcMain, app } from 'electron';
import fs from 'fs';
import path from 'path';
import {
  readFnFile,
  getRawBinaryInfo,
  validateFnFile,
  FnFileContent,
} from '../utils/fnFormat';
import { getFnTopicsDir, getFnFilePath } from '../utils/fnStorage';
import { retrieve, RetrieveOptions } from '../ai/retrieval';

export function registerFnInspectorIpcHandlers(): void {
  // Check development mode
  const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

  ipcMain.handle('fn-list', async () => {
    if (!isDev) return [];

    const fnDir = getFnTopicsDir();
    if (!fs.existsSync(fnDir)) return [];

    try {
      const files = await fs.promises.readdir(fnDir);
      const fnFiles = files.filter((f) => f.endsWith('.fn'));

      const list = await Promise.all(
        fnFiles.map(async (fileName) => {
          const filePath = path.join(fnDir, fileName);
          try {
            const stats = await fs.promises.stat(filePath);
            const content: FnFileContent = await readFnFile(filePath);
            return {
              uid: content.header.topicUid || content.topic.topicId,
              fileName,
              filePath,
              topicName: content.topic.topicName || 'Untitled Topic',
              fileSize: stats.size,
              updatedTimestamp: content.header.updatedTimestamp || stats.mtimeMs,
            };
          } catch {
            return {
              uid: fileName.replace('.fn', ''),
              fileName,
              filePath,
              topicName: fileName,
              fileSize: 0,
              updatedTimestamp: Date.now(),
            };
          }
        }),
      );

      return list;
    } catch (err) {
      console.error('[FN Inspector] Error listing .fn files:', err);
      return [];
    }
  });

  ipcMain.handle('fn-inspect', async (_, topicUid: string) => {
    if (!isDev) return null;
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return null;

    try {
      return await readFnFile(filePath);
    } catch (err) {
      console.error(`[FN Inspector] Error inspecting .fn file for topic '${topicUid}':`, err);
      return null;
    }
  });

  ipcMain.handle('fn-get-page', async (_, topicUid: string, pageNumber: number) => {
    if (!isDev) return null;
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = await readFnFile(filePath);
      return content.document?.pages?.find((p) => p.pageNumber === pageNumber) || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('fn-get-chunks', async (_, topicUid: string) => {
    if (!isDev) return [];
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = await readFnFile(filePath);
      return content.semantic?.chunks || [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('fn-get-embedding', async (_, topicUid: string, chunkId: string) => {
    if (!isDev) return null;
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return null;

    try {
      const content = await readFnFile(filePath);
      return content.rag?.embeddings?.find((e) => e.chunkId === chunkId || e.id === chunkId) || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle('fn-get-relationships', async (_, topicUid: string) => {
    if (!isDev) return [];
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return [];

    try {
      const content = await readFnFile(filePath);
      return content.semantic?.relationships || [];
    } catch {
      return [];
    }
  });

  ipcMain.handle('fn-search', async (_, query: string, options: RetrieveOptions = {}) => {
    if (!isDev) return { results: [], queryEmbedding: null };
    try {
      return await retrieve(query, options);
    } catch (err) {
      console.error('[FN Inspector] Search error:', err);
      return { results: [], queryEmbedding: null };
    }
  });

  ipcMain.handle('fn-validate', async (_, topicUid: string) => {
    if (!isDev) return null;
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return null;

    try {
      return await validateFnFile(filePath);
    } catch (err) {
      const error = err as Error;
      return {
        valid: false,
        errors: [error.message],
        warnings: [],
        info: {
          fileSize: 0,
          schemaVersion: 0,
          topicUid,
          pagesCount: 0,
          chunksCount: 0,
          embeddingsCount: 0,
          relationshipsCount: 0,
          imagesCount: 0,
          embeddingDimensions: 0,
        },
      };
    }
  });

  ipcMain.handle('fn-get-binary-info', async (_, topicUid: string) => {
    if (!isDev) return null;
    const filePath = getFnFilePath(topicUid);
    if (!fs.existsSync(filePath)) return null;

    try {
      return await getRawBinaryInfo(filePath);
    } catch (err) {
      console.error(`[FN Inspector] Error reading raw binary info for '${topicUid}':`, err);
      return null;
    }
  });
}
