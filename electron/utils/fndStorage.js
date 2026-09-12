"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFndTopicsDir = getFndTopicsDir;
exports.getFndFilePath = getFndFilePath;
exports.saveNoteImagesToFnd = saveNoteImagesToFnd;
exports.getFndImagePage = getFndImagePage;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const fndFormat_1 = require("./fndFormat");
const helpers_1 = require("./helpers");
function getFndTopicsDir() {
    const userDataPath = electron_1.app?.getPath ? electron_1.app.getPath('userData') : process.cwd();
    return path_1.default.join(userDataPath, 'fnd_topics');
}
function getFndFilePath(topicId) {
    const safeId = topicId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path_1.default.join(getFndTopicsDir(), `${safeId}.fnd`);
}
/**
 * Saves/packages all note page image files into a single `.fnd` binary container file.
 */
async function saveNoteImagesToFnd(note) {
    const topicId = note.topicId;
    if (!topicId || !Array.isArray(note.images) || note.images.length === 0)
        return;
    const fndPath = getFndFilePath(topicId);
    const now = Date.now();
    const fndImages = [];
    for (const img of note.images) {
        const rawPath = typeof img === 'string' ? img : img.filePath;
        const pageNum = typeof img === 'string' ? 0 : img.pageNumber;
        const localPath = (0, helpers_1.fromLocalImageUrl)(rawPath);
        if (fs_1.default.existsSync(localPath)) {
            try {
                const imageBuffer = await fs_1.default.promises.readFile(localPath);
                const ext = path_1.default.extname(localPath).toLowerCase();
                let mimeType = 'image/png';
                if (ext === '.jpg' || ext === '.jpeg')
                    mimeType = 'image/jpeg';
                else if (ext === '.webp')
                    mimeType = 'image/webp';
                fndImages.push({
                    id: `page-${pageNum}`,
                    pageNumber: pageNum,
                    mimeType,
                    description: `Note Page ${pageNum}`,
                    imageBuffer,
                });
            }
            catch (err) {
                console.warn(`[fndStorage] Failed to read image at '${localPath}':`, err);
            }
        }
    }
    if (fndImages.length === 0)
        return;
    const content = {
        header: {
            magic: fndFormat_1.FND_MAGIC,
            schemaVersion: fndFormat_1.CURRENT_FND_SCHEMA_VERSION,
            topicUid: topicId,
            createdTimestamp: note.timestamp || now,
            updatedTimestamp: now,
        },
        images: fndImages,
    };
    await (0, fndFormat_1.writeFndFile)(fndPath, content);
}
/**
 * Extracts a specific page image buffer from a topic's `.fnd` binary container.
 */
async function getFndImagePage(topicId, pageNumber) {
    const fndPath = getFndFilePath(topicId);
    if (!fs_1.default.existsSync(fndPath))
        return null;
    try {
        const content = await (0, fndFormat_1.readFndFile)(fndPath);
        const entry = content.images.find((img) => img.pageNumber === pageNumber);
        if (!entry)
            return null;
        return {
            buffer: entry.imageBuffer,
            mimeType: entry.mimeType,
        };
    }
    catch (err) {
        console.error(`[fndStorage] Failed to read page ${pageNumber} from '${fndPath}':`, err);
        return null;
    }
}
