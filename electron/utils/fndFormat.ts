import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export const FND_MAGIC = 'FND1'; // 4 bytes: 0x46, 0x4E, 0x44, 0x31
export const CURRENT_FND_SCHEMA_VERSION = 1;

export interface FndImageEntry {
  id: string;
  pageNumber: number;
  mimeType: string;
  description?: string;
  imageBuffer: Buffer;
}

export interface FndFileContent {
  header: {
    magic: string;
    schemaVersion: number;
    topicUid: string;
    createdTimestamp: number;
    updatedTimestamp: number;
  };
  images: FndImageEntry[];
}

/**
 * Serializes FndFileContent into binary Buffer.
 */
export function serializeFnd(content: FndFileContent): Buffer {
  const magicBuf = Buffer.from(FND_MAGIC, 'ascii'); // 4 bytes
  const imageCount = content.images.length;

  const headerMetaBuf = Buffer.alloc(4 + 36 + 8 + 8 + 4); // schemaVersion(4) + topicUid(36) + created(8) + updated(8) + imageCount(4)
  headerMetaBuf.writeUInt32BE(content.header.schemaVersion || CURRENT_FND_SCHEMA_VERSION, 0);

  const topicUidPadded = (content.header.topicUid || '').padEnd(36, ' ').substring(0, 36);
  headerMetaBuf.write(topicUidPadded, 4, 36, 'utf-8');

  const createdTime = BigInt(content.header.createdTimestamp || Date.now());
  const updatedTime = BigInt(content.header.updatedTimestamp || Date.now());

  headerMetaBuf.writeBigUInt64BE(createdTime, 40);
  headerMetaBuf.writeBigUInt64BE(updatedTime, 48);
  headerMetaBuf.writeUInt32BE(imageCount, 56);

  const serializedImages: { pageNumber: number; payload: Buffer }[] = [];

  for (const img of content.images) {
    const metaObj = {
      id: img.id,
      pageNumber: img.pageNumber,
      mimeType: img.mimeType || 'image/png',
      description: img.description || '',
    };
    const metaBuf = Buffer.from(JSON.stringify(metaObj), 'utf-8');
    const metaLenBuf = Buffer.alloc(4);
    metaLenBuf.writeUInt32BE(metaBuf.length, 0);

    const imgBuf = img.imageBuffer;
    const imgLenBuf = Buffer.alloc(4);
    imgLenBuf.writeUInt32BE(imgBuf.length, 0);

    const fullPayload = Buffer.concat([metaLenBuf, metaBuf, imgLenBuf, imgBuf]);
    serializedImages.push({
      pageNumber: img.pageNumber,
      payload: fullPayload,
    });
  }

  const indexTableSize = imageCount * 12; // pageNumber(4) + offset(4) + length(4)
  const headerTotalSize = 4 + headerMetaBuf.length + indexTableSize;

  let currentOffset = headerTotalSize;
  const indexTableBuf = Buffer.alloc(indexTableSize);

  serializedImages.forEach((img, idx) => {
    const entryOffset = idx * 12;
    indexTableBuf.writeUInt32BE(img.pageNumber, entryOffset);
    indexTableBuf.writeUInt32BE(currentOffset, entryOffset + 4);
    indexTableBuf.writeUInt32BE(img.payload.length, entryOffset + 8);
    currentOffset += img.payload.length;
  });

  const payloadBuffers = serializedImages.map((s) => s.payload);
  const mainDataBuf = Buffer.concat([magicBuf, headerMetaBuf, indexTableBuf, ...payloadBuffers]);

  const checksum = crypto.createHash('sha256').update(mainDataBuf).digest();
  return Buffer.concat([mainDataBuf, checksum]);
}

/**
 * Deserializes binary Buffer into FndFileContent.
 */
export function deserializeFnd(buffer: Buffer): FndFileContent {
  if (buffer.length < 60 + 32) {
    throw new Error('Invalid .fnd binary buffer: file size too small');
  }

  const magic = buffer.toString('ascii', 0, 4);
  if (magic !== FND_MAGIC) {
    throw new Error(`Invalid .fnd magic header: expected ${FND_MAGIC}, got ${magic}`);
  }

  const schemaVersion = buffer.readUInt32BE(4);
  const topicUid = buffer.toString('utf-8', 8, 44).trim();
  const createdTimestamp = Number(buffer.readBigUInt64BE(44));
  const updatedTimestamp = Number(buffer.readBigUInt64BE(52));
  const imageCount = buffer.readUInt32BE(60);

  const dataSize = buffer.length - 32;
  const storedChecksum = buffer.subarray(dataSize, buffer.length);
  const computedChecksum = crypto.createHash('sha256').update(buffer.subarray(0, dataSize)).digest();

  if (!storedChecksum.equals(computedChecksum)) {
    console.warn('[.fnd Reader] Warning: Checksum mismatch in .fnd binary file');
  }

  const images: FndImageEntry[] = [];
  const indexTableOffset = 64;

  for (let i = 0; i < imageCount; i++) {
    const entryOffset = indexTableOffset + i * 12;
    if (entryOffset + 12 > dataSize) break;

    const pageNumber = buffer.readUInt32BE(entryOffset);
    const offset = buffer.readUInt32BE(entryOffset + 4);
    const length = buffer.readUInt32BE(entryOffset + 8);

    if (offset + length > dataSize) continue;

    const payloadBuf = buffer.subarray(offset, offset + length);
    const metaLen = payloadBuf.readUInt32BE(0);
    const metaBuf = payloadBuf.subarray(4, 4 + metaLen);
    const meta = JSON.parse(metaBuf.toString('utf-8'));

    const imgLenOffset = 4 + metaLen;
    const imgLen = payloadBuf.readUInt32BE(imgLenOffset);
    const imageBuffer = payloadBuf.subarray(imgLenOffset + 4, imgLenOffset + 4 + imgLen);

    images.push({
      id: meta.id || `page-${pageNumber}`,
      pageNumber: meta.pageNumber || pageNumber,
      mimeType: meta.mimeType || 'image/png',
      description: meta.description,
      imageBuffer: Buffer.from(imageBuffer),
    });
  }

  return {
    header: {
      magic,
      schemaVersion,
      topicUid,
      createdTimestamp,
      updatedTimestamp,
    },
    images,
  };
}

/**
 * Atomic write for .fnd binary container files.
 */
export async function writeFndFile(filePath: string, content: FndFileContent): Promise<void> {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }

  const binaryBuf = serializeFnd(content);
  const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;

  try {
    const handle = await fs.promises.open(tempPath, 'w');
    await handle.write(binaryBuf, 0, binaryBuf.length, 0);
    await handle.sync();
    await handle.close();

    await fs.promises.rename(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) {
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        // ignore
      }
    }
    throw error;
  }
}

/**
 * Reads .fnd binary file asynchronously.
 */
export async function readFndFile(filePath: string): Promise<FndFileContent> {
  const buffer = await fs.promises.readFile(filePath);
  return deserializeFnd(buffer);
}
