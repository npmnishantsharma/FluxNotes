import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const FN_MAGIC = 'FN01'; // 4 bytes: 0x46, 0x4E, 0x30, 0x31
export const CURRENT_SCHEMA_VERSION = 1;

export interface FnTopicMetadata {
  topicId: string;
  topicName: string;
  chatUrl?: string;
  chatSessionId?: string | null;
  chatSession?: { conversationId?: string | null; parentMessageId?: string | null } | null;
  pinned?: boolean;
  notesTheme?: Record<string, unknown>;
  createdTimestamp: number;
  updatedTimestamp: number;
}

export interface FnOcrBlock {
  id: string;
  text: string;
  boundingBox?: { x: number; y: number; width: number; height: number };
  labels?: string[];
}

export interface FnHeading {
  text: string;
  level: number;
}

export interface FnSection {
  title: string;
  content: string;
}

export interface FnSubTopic {
  names: string[];
  pageNumber: string | number;
}

export interface FnTable {
  id: string;
  headers: string[];
  rows: string[][];
  caption?: string;
}

export interface FnEquation {
  id: string;
  latex: string;
  description?: string;
}

export interface FnPage {
  pageNumber: number;
  text: string;
  markdown?: string;
  headings: FnHeading[];
  sections: FnSection[];
  subTopics: FnSubTopic[];
  tables: FnTable[];
  equations: FnEquation[];
  ocrBlocks: FnOcrBlock[];
  images: Array<{ id: string; filePath?: string; pageNumber: number }>;
}

export interface FnAsset {
  id: string;
  pageNumber: number;
  filePath: string;
  mimeType: string;
  description?: string;
  ocrText?: string;
}

export interface FnChunk {
  id: string;
  topicUid: string;
  pageNumber: number;
  section: string;
  sourceType: 'text' | 'markdown' | 'heading' | 'section' | 'paragraph' | 'table' | 'equation' | 'ocr' | 'diagram' | 'subtopic';
  text: string;
  contentHash: string;
}

export type RelationshipType =
  | 'contains'
  | 'references'
  | 'belongs_to'
  | 'derived_from'
  | 'describes'
  | 'illustrates'
  | 'follows'
  | 'related_to';

export interface FnRelationship {
  id: string;
  fromId: string;
  toId: string;
  type: RelationshipType;
  metadata?: Record<string, unknown>;
}

export interface FnEmbedding {
  id: string;
  chunkId: string;
  model: string;
  dimensions: number;
  modality: 'text' | 'image' | 'multimodal';
  vector: number[];
  source: {
    pageNumber?: number;
    section?: string;
    subTopic?: string;
  };
  contentHash: string;
}

export interface FnFileContent {
  header: {
    magic: string;
    schemaVersion: number;
    topicUid: string;
    createdTimestamp: number;
    updatedTimestamp: number;
  };
  topic: FnTopicMetadata;
  document: {
    pages: FnPage[];
  };
  assets: {
    images: FnAsset[];
  };
  semantic: {
    chunks: FnChunk[];
    relationships: FnRelationship[];
  };
  rag: {
    model: string;
    dimensions: number;
    modality: 'text' | 'image' | 'multimodal';
    embeddings: FnEmbedding[];
  };
}

export interface FnSectionOffsetInfo {
  typeId: number;
  name: string;
  offset: number;
  length: number;
}

export interface FnRawBinaryInfo {
  magic: string;
  schemaVersion: number;
  topicUid: string;
  fileSize: number;
  createdTimestamp: number;
  updatedTimestamp: number;
  sections: FnSectionOffsetInfo[];
  checksumValid: boolean;
}

export interface FnValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  info: {
    fileSize: number;
    schemaVersion: number;
    topicUid: string;
    pagesCount: number;
    chunksCount: number;
    embeddingsCount: number;
    relationshipsCount: number;
    imagesCount: number;
    embeddingDimensions: number;
  };
}

const SECTION_TYPES = {
  TOPIC_METADATA: 1,
  DOCUMENT_PAGES: 2,
  ASSETS: 3,
  SEMANTIC_DATA: 4,
  RAG_DATA: 5,
} as const;

const SECTION_NAMES: Record<number, string> = {
  1: 'Topic Metadata',
  2: 'Document Pages',
  3: 'Assets',
  4: 'Semantic Data',
  5: 'RAG Data',
};

/**
 * Serializes an FnFileContent structure into a binary Buffer.
 */
export function serializeFn(content: FnFileContent): Buffer {
  const magicBuf = Buffer.from(FN_MAGIC, 'ascii'); // 4 bytes
  const headerMetaBuf = Buffer.alloc(4 + 36 + 8 + 8 + 4); // schemaVersion(4) + topicUid(36) + created(8) + updated(8) + sectionCount(4)

  headerMetaBuf.writeUInt32BE(content.header.schemaVersion || CURRENT_SCHEMA_VERSION, 0);

  // Format 36-char fixed UUID string
  const topicUidPadded = (content.header.topicUid || content.topic.topicId || '').padEnd(36, ' ').substring(0, 36);
  headerMetaBuf.write(topicUidPadded, 4, 36, 'utf-8');

  const createdTime = BigInt(content.header.createdTimestamp || content.topic.createdTimestamp || Date.now());
  const updatedTime = BigInt(content.header.updatedTimestamp || content.topic.updatedTimestamp || Date.now());

  headerMetaBuf.writeBigUInt64BE(createdTime, 40);
  headerMetaBuf.writeBigUInt64BE(updatedTime, 48);

  const sectionsList: { typeId: number; payload: Buffer }[] = [];

  // Section 1: Topic Metadata
  const topicJsonBuf = Buffer.from(JSON.stringify(content.topic), 'utf-8');
  sectionsList.push({ typeId: SECTION_TYPES.TOPIC_METADATA, payload: topicJsonBuf });

  // Section 2: Document Pages
  const docJsonBuf = Buffer.from(JSON.stringify(content.document || { pages: [] }), 'utf-8');
  sectionsList.push({ typeId: SECTION_TYPES.DOCUMENT_PAGES, payload: docJsonBuf });

  // Section 3: Assets
  const assetsJsonBuf = Buffer.from(JSON.stringify(content.assets || { images: [] }), 'utf-8');
  sectionsList.push({ typeId: SECTION_TYPES.ASSETS, payload: assetsJsonBuf });

  // Section 4: Semantic Data
  const semanticJsonBuf = Buffer.from(JSON.stringify(content.semantic || { chunks: [], relationships: [] }), 'utf-8');
  sectionsList.push({ typeId: SECTION_TYPES.SEMANTIC_DATA, payload: semanticJsonBuf });

  // Section 5: RAG Data (Embeddings metadata + Float32Array vectors)
  const rag = content.rag || { model: 'text-embedding-3-small', dimensions: 1536, modality: 'text', embeddings: [] };
  const embeddingsData = (rag.embeddings || []).map((emb) => {
    // Convert vector float array into base64 encoded Float32Array string or binary buffer for serialization
    const floatArr = new Float32Array(emb.vector || []);
    const floatBuf = Buffer.from(floatArr.buffer, floatArr.byteOffset, floatArr.byteLength);
    return {
      id: emb.id,
      chunkId: emb.chunkId,
      model: emb.model,
      dimensions: emb.dimensions,
      modality: emb.modality,
      source: emb.source,
      contentHash: emb.contentHash,
      vectorBase64: floatBuf.toString('base64'),
    };
  });

  const ragMeta = {
    model: rag.model,
    dimensions: rag.dimensions,
    modality: rag.modality,
    embeddings: embeddingsData,
  };
  const ragJsonBuf = Buffer.from(JSON.stringify(ragMeta), 'utf-8');
  sectionsList.push({ typeId: SECTION_TYPES.RAG_DATA, payload: ragJsonBuf });

  headerMetaBuf.writeUInt32BE(sectionsList.length, 56);

  const indexTableSize = sectionsList.length * 12; // typeId(4) + offset(4) + length(4)
  const headerTotalSize = 4 + headerMetaBuf.length + indexTableSize;

  let currentOffset = headerTotalSize;
  const indexTableBuf = Buffer.alloc(indexTableSize);

  sectionsList.forEach((sec, idx) => {
    const entryOffset = idx * 12;
    indexTableBuf.writeUInt32BE(sec.typeId, entryOffset);
    indexTableBuf.writeUInt32BE(currentOffset, entryOffset + 4);
    indexTableBuf.writeUInt32BE(sec.payload.length, entryOffset + 8);
    currentOffset += sec.payload.length;
  });

  const payloadBuffers = sectionsList.map((s) => s.payload);

  const mainDataBuf = Buffer.concat([magicBuf, headerMetaBuf, indexTableBuf, ...payloadBuffers]);

  // Append SHA-256 Checksum (32 bytes) at the end
  const checksum = crypto.createHash('sha256').update(mainDataBuf).digest();

  return Buffer.concat([mainDataBuf, checksum]);
}

/**
 * Deserializes a binary Buffer into an FnFileContent structure.
 */
export function deserializeFn(buffer: Buffer): FnFileContent {
  if (buffer.length < 60 + 32) {
    throw new Error('Invalid .fn binary buffer: file size too small');
  }

  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== FN_MAGIC) {
    throw new Error(`Invalid .fn magic header: expected ${FN_MAGIC}, got ${magic}`);
  }

  const schemaVersion = buffer.readUInt32BE(4);
  const topicUid = buffer.toString('utf-8', 8, 44).trim();
  const createdTimestamp = Number(buffer.readBigUInt64BE(44));
  const updatedTimestamp = Number(buffer.readBigUInt64BE(52));
  const sectionCount = buffer.readUInt32BE(60);

  // Checksum verification
  const dataSize = buffer.length - 32;
  const storedChecksum = buffer.subarray(dataSize, buffer.length);
  const computedChecksum = crypto.createHash('sha256').update(buffer.subarray(0, dataSize)).digest();

  if (!storedChecksum.equals(computedChecksum)) {
    console.warn('[.fn Reader] Warning: Checksum mismatch in .fn binary file');
  }

  let topic: FnTopicMetadata = {
    topicId: topicUid,
    topicName: '',
    createdTimestamp,
    updatedTimestamp,
  };
  let document = { pages: [] as FnPage[] };
  let assets = { images: [] as FnAsset[] };
  let semantic = { chunks: [] as FnChunk[], relationships: [] as FnRelationship[] };
  let rag = {
    model: 'text-embedding-3-small',
    dimensions: 1536,
    modality: 'text' as const,
    embeddings: [] as FnEmbedding[],
  };

  const indexTableOffset = 64;
  for (let i = 0; i < sectionCount; i++) {
    const entryOffset = indexTableOffset + i * 12;
    if (entryOffset + 12 > dataSize) break;

    const typeId = buffer.readUInt32BE(entryOffset);
    const offset = buffer.readUInt32BE(entryOffset + 4);
    const length = buffer.readUInt32BE(entryOffset + 8);

    if (offset + length > dataSize) continue;

    const sectionBuf = buffer.subarray(offset, offset + length);
    const sectionJson = sectionBuf.toString('utf-8');

    try {
      if (typeId === SECTION_TYPES.TOPIC_METADATA) {
        topic = JSON.parse(sectionJson);
      } else if (typeId === SECTION_TYPES.DOCUMENT_PAGES) {
        document = JSON.parse(sectionJson);
      } else if (typeId === SECTION_TYPES.ASSETS) {
        assets = JSON.parse(sectionJson);
      } else if (typeId === SECTION_TYPES.SEMANTIC_DATA) {
        semantic = JSON.parse(sectionJson);
      } else if (typeId === SECTION_TYPES.RAG_DATA) {
        const parsedRag = JSON.parse(sectionJson);
        const deserializedEmbeddings: FnEmbedding[] = (parsedRag.embeddings || []).map((emb: {
          id: string;
          chunkId: string;
          model: string;
          dimensions: number;
          modality: 'text' | 'image' | 'multimodal';
          source: { pageNumber?: number; section?: string; subTopic?: string };
          contentHash: string;
          vectorBase64?: string;
          vector?: number[];
        }) => {
          let vector: number[] = [];
          if (emb.vectorBase64) {
            const floatBuf = Buffer.from(emb.vectorBase64, 'base64');
            const floatArr = new Float32Array(
              floatBuf.buffer,
              floatBuf.byteOffset,
              floatBuf.byteLength / Float32Array.BYTES_PER_ELEMENT,
            );
            vector = Array.from(floatArr);
          } else if (Array.isArray(emb.vector)) {
            vector = emb.vector;
          }
          return {
            id: emb.id,
            chunkId: emb.chunkId,
            model: emb.model,
            dimensions: emb.dimensions || vector.length,
            modality: emb.modality || 'text',
            source: emb.source || {},
            contentHash: emb.contentHash,
            vector,
          };
        });

        rag = {
          model: parsedRag.model || 'text-embedding-3-small',
          dimensions: parsedRag.dimensions || 1536,
          modality: parsedRag.modality || 'text',
          embeddings: deserializedEmbeddings,
        };
      }
    } catch (parseErr) {
      console.error(`Error parsing section ${typeId}:`, parseErr);
    }
  }

  return {
    header: {
      magic,
      schemaVersion,
      topicUid: topic.topicId || topicUid,
      createdTimestamp,
      updatedTimestamp,
    },
    topic,
    document,
    assets,
    semantic,
    rag,
  };
}

/**
 * Atomic Binary Write for `.fn` files: Writes to temporary file, flushes, and renames atomically.
 */
export async function writeFnFile(filePath: string, content: FnFileContent): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const binaryBuf = serializeFn(content);
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;

  try {
    const handle = await fs.promises.open(tempPath, 'w');
    await handle.write(binaryBuf, 0, binaryBuf.length, 0);
    await handle.sync(); // Flush data to disk
    await handle.close();

    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // Ignore failure to cleanup temp file
      }
    }
    throw error;
  }
}

/**
 * Reads a `.fn` binary file asynchronously.
 */
export async function readFnFile(filePath: string): Promise<FnFileContent> {
  const buffer = await fs.promises.readFile(filePath);
  return deserializeFn(buffer);
}

/**
 * Low-level inspection tool for raw `.fn` binary offset layout and structure.
 */
export async function getRawBinaryInfo(filePath: string): Promise<FnRawBinaryInfo> {
  const buffer = await fs.promises.readFile(filePath);

  if (buffer.length < 60 + 32) {
    throw new Error('Invalid .fn file: file too small');
  }

  const magic = buffer.toString('ascii', 0, 4);
  const schemaVersion = buffer.readUInt32BE(4);
  const topicUid = buffer.toString('utf-8', 8, 44).trim();
  const createdTimestamp = Number(buffer.readBigUInt64BE(44));
  const updatedTimestamp = Number(buffer.readBigUInt64BE(52));
  const sectionCount = buffer.readUInt32BE(60);

  const dataSize = buffer.length - 32;
  const storedChecksum = buffer.subarray(dataSize, buffer.length);
  const computedChecksum = crypto.createHash('sha256').update(buffer.subarray(0, dataSize)).digest();
  const checksumValid = storedChecksum.equals(computedChecksum);

  const sections: FnSectionOffsetInfo[] = [];
  const indexTableOffset = 64;

  for (let i = 0; i < sectionCount; i++) {
    const entryOffset = indexTableOffset + i * 12;
    if (entryOffset + 12 > dataSize) break;

    const typeId = buffer.readUInt32BE(entryOffset);
    const offset = buffer.readUInt32BE(entryOffset + 4);
    const length = buffer.readUInt32BE(entryOffset + 8);

    sections.push({
      typeId,
      name: SECTION_NAMES[typeId] || `Unknown Section (${typeId})`,
      offset,
      length,
    });
  }

  return {
    magic,
    schemaVersion,
    topicUid,
    fileSize: buffer.length,
    createdTimestamp,
    updatedTimestamp,
    sections,
    checksumValid,
  };
}

/**
 * Health check & validation for `.fn` files.
 */
export async function validateFnFile(filePath: string): Promise<FnValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let content: FnFileContent | null = null;
  let rawInfo: FnRawBinaryInfo | null = null;

  try {
    rawInfo = await getRawBinaryInfo(filePath);
    if (rawInfo.magic !== FN_MAGIC) {
      errors.push(`Invalid magic header: expected '${FN_MAGIC}', got '${rawInfo.magic}'`);
    }
    if (!rawInfo.checksumValid) {
      warnings.push('Binary SHA-256 checksum mismatch');
    }
  } catch (err) {
    const error = err as Error;
    errors.push(`Failed to read binary header: ${error.message}`);
  }

  try {
    content = await readFnFile(filePath);
  } catch (err) {
    const error = err as Error;
    errors.push(`Failed to deserialize .fn file: ${error.message}`);
  }

  if (!content) {
    return {
      valid: false,
      errors,
      warnings,
      info: {
        fileSize: rawInfo?.fileSize || 0,
        schemaVersion: rawInfo?.schemaVersion || 0,
        topicUid: rawInfo?.topicUid || '',
        pagesCount: 0,
        chunksCount: 0,
        embeddingsCount: 0,
        relationshipsCount: 0,
        imagesCount: 0,
        embeddingDimensions: 0,
      },
    };
  }

  const pages = content.document?.pages || [];
  const chunks = content.semantic?.chunks || [];
  const embeddings = content.rag?.embeddings || [];
  const relationships = content.semantic?.relationships || [];
  const images = content.assets?.images || [];

  const chunkIds = new Set(chunks.map((c) => c.id));
  const embeddingChunkIds = new Set(embeddings.map((e) => e.chunkId));
  const entityIds = new Set([
    content.topic.topicId,
    ...pages.map((p) => `page-${p.pageNumber}`),
    ...chunks.map((c) => c.id),
    ...images.map((i) => i.id),
    ...embeddings.map((e) => e.id),
  ]);

  // Validate Chunks
  for (const chunk of chunks) {
    if (!chunk.id) errors.push('Chunk missing ID');
    if (!chunk.contentHash) warnings.push(`Chunk ${chunk.id} missing contentHash`);
  }

  // Validate Embeddings
  const dimensions = content.rag?.dimensions || 1536;
  for (const emb of embeddings) {
    if (!chunkIds.has(emb.chunkId)) {
      warnings.push(`Orphan embedding ${emb.id} references non-existent chunk ${emb.chunkId}`);
    }
    if (emb.vector.length !== dimensions && emb.vector.length > 0) {
      errors.push(`Embedding ${emb.id} vector length (${emb.vector.length}) does not match model dimensions (${dimensions})`);
    }
    if (emb.vector.some((v) => typeof v !== 'number' || isNaN(v))) {
      errors.push(`Embedding ${emb.id} contains NaN or invalid numeric values`);
    }
  }

  // Check orphan chunks without embeddings
  for (const chunk of chunks) {
    if (!embeddingChunkIds.has(chunk.id)) {
      warnings.push(`Chunk ${chunk.id} has no corresponding embedding`);
    }
  }

  // Validate Relationships
  for (const rel of relationships) {
    if (!rel.fromId || !rel.toId) {
      errors.push(`Invalid relationship ${rel.id}: missing fromId or toId`);
    }
    if (!entityIds.has(rel.fromId)) {
      warnings.push(`Relationship ${rel.id} fromId '${rel.fromId}' not found in entity registry`);
    }
    if (!entityIds.has(rel.toId)) {
      warnings.push(`Relationship ${rel.id} toId '${rel.toId}' not found in entity registry`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    info: {
      fileSize: rawInfo?.fileSize || 0,
      schemaVersion: content.header.schemaVersion,
      topicUid: content.header.topicUid,
      pagesCount: pages.length,
      chunksCount: chunks.length,
      embeddingsCount: embeddings.length,
      relationshipsCount: relationships.length,
      imagesCount: images.length,
      embeddingDimensions: dimensions,
    },
  };
}
