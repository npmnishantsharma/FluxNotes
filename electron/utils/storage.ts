import { app } from 'electron';
import path from 'path';
import fs from 'fs';
import { NoteRecord, ImageRecord, NotesData, RawResponseData, FailedPage } from '../types';
import { extractJsonFromResponse, completeTruncatedJson } from './helpers';
import { logError } from './logger';

export const dataFilePath = path.join(app.getPath('userData'), 'notes_data.json');
export const imagesDir = path.join(app.getPath('userData'), 'images');
export const resultsDir = path.join(app.getPath('userData'), 'results');

export const RESULT_JSON_PATH = path.resolve(__dirname, '..', '..', 'result.json');
export const RAW_JSON_PATH = path.resolve(__dirname, '..', '..', 'raw.json');

export function ensureDirectoriesExist(): void {
  if (!fs.existsSync(imagesDir)) {
    fs.mkdirSync(imagesDir, { recursive: true });
  }
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
}

// PERFORMANCE OPTIMIZATION: In-memory cache for NotesData to prevent repeated disk I/O operations.
let notesDataCache: NotesData | null = null;

export function clearNotesDataCache(): void {
  notesDataCache = null;
}

export async function readDataFileAsync(): Promise<NotesData> {
  // PERFORMANCE OPTIMIZATION: Return structuredClone of in-memory notesDataCache to eliminate disk read latency and isolate references across IPC lifecycles.
  if (notesDataCache !== null) {
    return structuredClone(notesDataCache);
  }

  try {
    if (fs.existsSync(dataFilePath)) {
      const rawData = await fs.promises.readFile(dataFilePath, 'utf-8');
      const parsed = JSON.parse(rawData);
      notesDataCache = {
        notes_collection: Array.isArray(parsed.notes_collection) ? parsed.notes_collection : [],
        image_records: Array.isArray(parsed.image_records) ? parsed.image_records : [],
        failed_pages: Array.isArray(parsed.failed_pages) ? parsed.failed_pages : [],
      };
      return structuredClone(notesDataCache);
    }
  } catch (err) {
    const error = err as Error;
    console.error('Failed to read local JSON data file:', err);
    logError({
      category: 'storage',
      message: 'Failed to read local JSON data file',
      details: { error: error.message, stack: error.stack, filePath: dataFilePath },
    });
  }

  notesDataCache = { notes_collection: [], image_records: [], failed_pages: [] };
  return structuredClone(notesDataCache);
}

export async function writeDataFileAsync(data: NotesData): Promise<void> {
  try {
    await fs.promises.writeFile(dataFilePath, JSON.stringify(data, null, 2), 'utf-8');
    // PERFORMANCE OPTIMIZATION: Update in-memory cache strictly after the asynchronous file write operation succeeds to prevent cache inconsistency.
    notesDataCache = structuredClone(data);
  } catch (err) {
    const error = err as Error;
    console.error('Failed to write local JSON data file:', err);
    logError({
      category: 'storage',
      message: 'Failed to write local JSON data file',
      details: { error: error.message, stack: error.stack, filePath: dataFilePath },
    });
  }
}

export async function getStoredNotes(): Promise<NoteRecord[]> {
  const data = await readDataFileAsync();
  return data.notes_collection;
}

export async function getStoredRecords(): Promise<ImageRecord[]> {
  const data = await readDataFileAsync();
  return data.image_records;
}

export async function saveRecordToDb(record: ImageRecord): Promise<void> {
  const data = await readDataFileAsync();
  data.image_records.push(record);
  await writeDataFileAsync(data);
}

export async function saveNotesCollection(notes: NoteRecord[]): Promise<void> {
  const data = await readDataFileAsync();
  data.notes_collection = notes;
  await writeDataFileAsync(data);
}

export async function saveImageRecords(records: ImageRecord[]): Promise<void> {
  const data = await readDataFileAsync();
  data.image_records = records;
  await writeDataFileAsync(data);
}

export async function saveFailedPage(failedPage: FailedPage): Promise<void> {
  const data = await readDataFileAsync();
  if (!data.failed_pages) {
    data.failed_pages = [];
  }
  
  // Remove existing failed page for the same page number and session
  data.failed_pages = data.failed_pages.filter(
    fp => !(fp.pageNumber === failedPage.pageNumber && fp.sessionId === failedPage.sessionId)
  );
  
  data.failed_pages.push(failedPage);
  await writeDataFileAsync(data);
}

export async function getFailedPages(): Promise<FailedPage[]> {
  const data = await readDataFileAsync();
  return data.failed_pages || [];
}

export async function removeFailedPage(pageNumber: number, sessionId: string): Promise<void> {
  const data = await readDataFileAsync();
  if (data.failed_pages) {
    data.failed_pages = data.failed_pages.filter(
      fp => !(fp.pageNumber === pageNumber && fp.sessionId === sessionId)
    );
    await writeDataFileAsync(data);
  }
}

export async function writeRawResponse(responseData: RawResponseData): Promise<void> {
  try {
    let formattedJson: unknown = null;
    try {
      const jsonText = extractJsonFromResponse(responseData.rawResponse);
      formattedJson = JSON.parse(completeTruncatedJson(jsonText));
    } catch {
      // Preserve raw response when not JSON
    }

    //await fs.promises.writeFile(
    //  RAW_JSON_PATH,
    //  JSON.stringify({ ...responseData, formattedJson }, null, 2),
    //  'utf8',
    // );
    console.log(`[raw.json] Saved latest raw response -> ${RAW_JSON_PATH}`);
  } catch (error) {
    const err = error as Error;
    console.error('[raw.json] Failed to save raw response:', err.message);
    logError({
      category: 'storage',
      message: 'Failed to save raw response to raw.json',
      details: { error: err.message, stack: err.stack, filePath: RAW_JSON_PATH },
    });
  }
}

export function appendToResultJson(entry: Record<string, unknown>): void {
  if (!app.isPackaged) {
    try {
      let arr: Record<string, unknown>[] = [];
      try {
        if (fs.existsSync(RESULT_JSON_PATH)) {
          const raw = fs.readFileSync(RESULT_JSON_PATH, 'utf8');
          if (raw && raw.trim()) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) arr = parsed;
          }
        }
      } catch (e) {
        const err = e as Error;
        console.warn('[result.json] Failed to read existing file, starting fresh:', err.message);
        logError({
          category: 'storage',
          message: 'Failed to read existing result.json file',
          details: { error: err.message, stack: err.stack, filePath: RESULT_JSON_PATH },
        });
        arr = [];
      }
      arr.push({
        timestamp: new Date().toISOString(),
        ...entry,
      });
      // fs.writeFileSync(RESULT_JSON_PATH, JSON.stringify(arr, null, 2), 'utf8');
      console.log(`[result.json] Appended entry #${arr.length} -> ${RESULT_JSON_PATH}`);
    } catch (writeErr) {
      const err = writeErr as Error;
      console.error('[result.json] Failed to write:', err.message);
      logError({
        category: 'storage',
        message: 'Failed to write to result.json',
        details: { error: err.message, stack: err.stack, filePath: RESULT_JSON_PATH },
      });
    }
  }
}
