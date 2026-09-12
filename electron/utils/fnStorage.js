"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFnTopicsDir = getFnTopicsDir;
exports.getFnFilePath = getFnFilePath;
exports.saveNoteToFn = saveNoteToFn;
exports.deleteFnFile = deleteFnFile;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const electron_1 = require("electron");
const fnFormat_1 = require("./fnFormat");
const chunker_1 = require("../ai/chunker");
const embeddings_1 = require("../ai/embeddings");
function getFnTopicsDir() {
    const userDataPath = electron_1.app?.getPath ? electron_1.app.getPath('userData') : process.cwd();
    return path_1.default.join(userDataPath, 'fn_topics');
}
function getFnFilePath(topicId) {
    const safeId = topicId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return path_1.default.join(getFnTopicsDir(), `${safeId}.fn`);
}
/**
 * Saves a note to its custom `.fn` binary container and updates RAG index.
 */
async function saveNoteToFn(note) {
    const topicId = note.topicId;
    if (!topicId)
        return;
    const fnPath = getFnFilePath(topicId);
    let existingContent = null;
    if (fs_1.default.existsSync(fnPath)) {
        try {
            existingContent = await (0, fnFormat_1.readFnFile)(fnPath);
        }
        catch (err) {
            console.warn(`[fnStorage] Failed to read existing .fn file at '${fnPath}':`, err);
        }
    }
    const { pages, chunks, relationships, images } = (0, chunker_1.chunkNoteRecord)(note);
    const provider = new embeddings_1.HttpEmbeddingProvider();
    const embeddings = await (0, embeddings_1.reindexTopicEmbeddings)(existingContent, chunks, provider);
    const now = Date.now();
    const createdTimestamp = existingContent?.header?.createdTimestamp || note.timestamp || now;
    const fnContent = {
        header: {
            magic: fnFormat_1.FN_MAGIC,
            schemaVersion: fnFormat_1.CURRENT_SCHEMA_VERSION,
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
    await (0, fnFormat_1.writeFnFile)(fnPath, fnContent);
}
/**
 * Deletes the `.fn` binary container for a topic.
 */
async function deleteFnFile(topicId) {
    if (!topicId)
        return;
    const fnPath = getFnFilePath(topicId);
    if (fs_1.default.existsSync(fnPath)) {
        try {
            await fs_1.default.promises.unlink(fnPath);
        }
        catch (err) {
            console.error(`[fnStorage] Failed to delete .fn file '${fnPath}':`, err);
        }
    }
}
