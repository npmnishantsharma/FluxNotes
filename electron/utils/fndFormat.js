"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CURRENT_FND_SCHEMA_VERSION = exports.FND_MAGIC = void 0;
exports.serializeFnd = serializeFnd;
exports.deserializeFnd = deserializeFnd;
exports.writeFndFile = writeFndFile;
exports.readFndFile = readFndFile;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
exports.FND_MAGIC = 'FND1'; // 4 bytes: 0x46, 0x4E, 0x44, 0x31
exports.CURRENT_FND_SCHEMA_VERSION = 1;
/**
 * Serializes FndFileContent into binary Buffer.
 */
function serializeFnd(content) {
    const magicBuf = Buffer.from(exports.FND_MAGIC, 'ascii'); // 4 bytes
    const imageCount = content.images.length;
    const headerMetaBuf = Buffer.alloc(4 + 36 + 8 + 8 + 4); // schemaVersion(4) + topicUid(36) + created(8) + updated(8) + imageCount(4)
    headerMetaBuf.writeUInt32BE(content.header.schemaVersion || exports.CURRENT_FND_SCHEMA_VERSION, 0);
    const topicUidPadded = (content.header.topicUid || '').padEnd(36, ' ').substring(0, 36);
    headerMetaBuf.write(topicUidPadded, 4, 36, 'utf-8');
    const createdTime = BigInt(content.header.createdTimestamp || Date.now());
    const updatedTime = BigInt(content.header.updatedTimestamp || Date.now());
    headerMetaBuf.writeBigUInt64BE(createdTime, 40);
    headerMetaBuf.writeBigUInt64BE(updatedTime, 48);
    headerMetaBuf.writeUInt32BE(imageCount, 56);
    const serializedImages = [];
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
    const checksum = crypto_1.default.createHash('sha256').update(mainDataBuf).digest();
    return Buffer.concat([mainDataBuf, checksum]);
}
/**
 * Deserializes binary Buffer into FndFileContent.
 */
function deserializeFnd(buffer) {
    if (buffer.length < 60 + 32) {
        throw new Error('Invalid .fnd binary buffer: file size too small');
    }
    const magic = buffer.toString('ascii', 0, 4);
    if (magic !== exports.FND_MAGIC) {
        throw new Error(`Invalid .fnd magic header: expected ${exports.FND_MAGIC}, got ${magic}`);
    }
    const schemaVersion = buffer.readUInt32BE(4);
    const topicUid = buffer.toString('utf-8', 8, 44).trim();
    const createdTimestamp = Number(buffer.readBigUInt64BE(44));
    const updatedTimestamp = Number(buffer.readBigUInt64BE(52));
    const imageCount = buffer.readUInt32BE(60);
    const dataSize = buffer.length - 32;
    const storedChecksum = buffer.subarray(dataSize, buffer.length);
    const computedChecksum = crypto_1.default.createHash('sha256').update(buffer.subarray(0, dataSize)).digest();
    if (!storedChecksum.equals(computedChecksum)) {
        console.warn('[.fnd Reader] Warning: Checksum mismatch in .fnd binary file');
    }
    const images = [];
    const indexTableOffset = 64;
    for (let i = 0; i < imageCount; i++) {
        const entryOffset = indexTableOffset + i * 12;
        if (entryOffset + 12 > dataSize)
            break;
        const pageNumber = buffer.readUInt32BE(entryOffset);
        const offset = buffer.readUInt32BE(entryOffset + 4);
        const length = buffer.readUInt32BE(entryOffset + 8);
        if (offset + length > dataSize)
            continue;
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
async function writeFndFile(filePath, content) {
    const dir = path_1.default.dirname(filePath);
    if (!fs_1.default.existsSync(dir)) {
        await fs_1.default.promises.mkdir(dir, { recursive: true });
    }
    const binaryBuf = serializeFnd(content);
    const tempPath = `${filePath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    try {
        const handle = await fs_1.default.promises.open(tempPath, 'w');
        await handle.write(binaryBuf, 0, binaryBuf.length, 0);
        await handle.sync();
        await handle.close();
        await fs_1.default.promises.rename(tempPath, filePath);
    }
    catch (error) {
        if (fs_1.default.existsSync(tempPath)) {
            try {
                await fs_1.default.promises.unlink(tempPath);
            }
            catch {
                // ignore
            }
        }
        throw error;
    }
}
/**
 * Reads .fnd binary file asynchronously.
 */
async function readFndFile(filePath) {
    const buffer = await fs_1.default.promises.readFile(filePath);
    return deserializeFnd(buffer);
}
