"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFnInspectorIpcHandlers = registerFnInspectorIpcHandlers;
const electron_1 = require("electron");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const fnFormat_1 = require("../utils/fnFormat");
const fnStorage_1 = require("../utils/fnStorage");
const retrieval_1 = require("../ai/retrieval");
function registerFnInspectorIpcHandlers() {
    // Check development mode
    const isDev = !electron_1.app.isPackaged || process.env.NODE_ENV === 'development';
    electron_1.ipcMain.handle('fn-list', async () => {
        if (!isDev)
            return [];
        const fnDir = (0, fnStorage_1.getFnTopicsDir)();
        if (!fs_1.default.existsSync(fnDir))
            return [];
        try {
            const files = await fs_1.default.promises.readdir(fnDir);
            const fnFiles = files.filter((f) => f.endsWith('.fn'));
            const list = await Promise.all(fnFiles.map(async (fileName) => {
                const filePath = path_1.default.join(fnDir, fileName);
                const rawUid = fileName.slice(0, -3); // remove .fn extension
                try {
                    const stats = await fs_1.default.promises.stat(filePath);
                    const content = await (0, fnFormat_1.readFnFile)(filePath);
                    return {
                        uid: rawUid || content.header?.topicUid || content.topic?.topicId || rawUid,
                        fileName,
                        filePath,
                        topicName: content.topic?.topicName || 'Untitled Topic',
                        fileSize: stats.size,
                        updatedTimestamp: content.header?.updatedTimestamp || stats.mtimeMs,
                    };
                }
                catch {
                    return {
                        uid: rawUid,
                        fileName,
                        filePath,
                        topicName: fileName,
                        fileSize: 0,
                        updatedTimestamp: Date.now(),
                    };
                }
            }));
            return list;
        }
        catch (err) {
            console.error('[FN Inspector] Error listing .fn files:', err);
            return [];
        }
    });
    electron_1.ipcMain.handle('fn-inspect', async (_, topicUid) => {
        if (!isDev)
            return null;
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return null;
        try {
            return await (0, fnFormat_1.readFnFile)(filePath);
        }
        catch (err) {
            console.error(`[FN Inspector] Error inspecting .fn file for topic '${topicUid}':`, err);
            return null;
        }
    });
    electron_1.ipcMain.handle('fn-get-page', async (_, topicUid, pageNumber) => {
        if (!isDev)
            return null;
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return null;
        try {
            const content = await (0, fnFormat_1.readFnFile)(filePath);
            return content.document?.pages?.find((p) => p.pageNumber === pageNumber) || null;
        }
        catch {
            return null;
        }
    });
    electron_1.ipcMain.handle('fn-get-chunks', async (_, topicUid) => {
        if (!isDev)
            return [];
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return [];
        try {
            const content = await (0, fnFormat_1.readFnFile)(filePath);
            return content.semantic?.chunks || [];
        }
        catch {
            return [];
        }
    });
    electron_1.ipcMain.handle('fn-get-embedding', async (_, topicUid, chunkId) => {
        if (!isDev)
            return null;
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return null;
        try {
            const content = await (0, fnFormat_1.readFnFile)(filePath);
            return content.rag?.embeddings?.find((e) => e.chunkId === chunkId || e.id === chunkId) || null;
        }
        catch {
            return null;
        }
    });
    electron_1.ipcMain.handle('fn-get-relationships', async (_, topicUid) => {
        if (!isDev)
            return [];
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return [];
        try {
            const content = await (0, fnFormat_1.readFnFile)(filePath);
            return content.semantic?.relationships || [];
        }
        catch {
            return [];
        }
    });
    electron_1.ipcMain.handle('fn-search', async (_, query, options = {}) => {
        if (!isDev)
            return { results: [], queryEmbedding: null };
        try {
            return await (0, retrieval_1.retrieve)(query, options);
        }
        catch (err) {
            console.error('[FN Inspector] Search error:', err);
            return { results: [], queryEmbedding: null };
        }
    });
    electron_1.ipcMain.handle('fn-validate', async (_, topicUid) => {
        if (!isDev)
            return null;
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return null;
        try {
            return await (0, fnFormat_1.validateFnFile)(filePath);
        }
        catch (err) {
            const error = err;
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
    electron_1.ipcMain.handle('fn-get-binary-info', async (_, topicUid) => {
        if (!isDev)
            return null;
        const filePath = (0, fnStorage_1.getFnFilePath)(topicUid);
        if (!fs_1.default.existsSync(filePath))
            return null;
        try {
            return await (0, fnFormat_1.getRawBinaryInfo)(filePath);
        }
        catch (err) {
            console.error(`[FN Inspector] Error reading raw binary info for '${topicUid}':`, err);
            return null;
        }
    });
}
