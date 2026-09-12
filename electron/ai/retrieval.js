"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFnTopicsDir = getFnTopicsDir;
exports.retrieve = retrieve;
exports.buildRagContext = buildRagContext;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const electron_1 = require("electron");
const fnFormat_1 = require("../utils/fnFormat");
const embeddings_1 = require("./embeddings");
function getFnTopicsDir() {
    const userData = electron_1.app?.getPath ? electron_1.app.getPath('userData') : process.cwd();
    return path_1.default.join(userData, 'fn_topics');
}
/**
 * Searches across one or multiple `.fn` files using cosine similarity.
 */
async function retrieve(query, options = {}, provider) {
    const activeProvider = provider || new embeddings_1.HttpEmbeddingProvider();
    const queryVector = await activeProvider.embed(query);
    const queryEmbedding = {
        query,
        model: activeProvider.getModelName(),
        dimensions: activeProvider.getDimensions(),
        vector: queryVector,
    };
    const topK = options.topK || 5;
    const minScore = options.minScore ?? -1.0;
    const targetUid = options.uid || options.topicId;
    const fnDir = getFnTopicsDir();
    const candidates = [];
    if (fs_1.default.existsSync(fnDir)) {
        const files = await fs_1.default.promises.readdir(fnDir);
        const fnFiles = files.filter((f) => f.endsWith('.fn'));
        for (const fileName of fnFiles) {
            const filePath = path_1.default.join(fnDir, fileName);
            try {
                const fnContent = await (0, fnFormat_1.readFnFile)(filePath);
                const fileUid = fnContent.header.topicUid || fnContent.topic.topicId;
                if (targetUid && fileUid !== targetUid && !fileName.includes(targetUid)) {
                    continue;
                }
                const topicName = fnContent.topic.topicName || 'Untitled Topic';
                const chunksMap = new Map((fnContent.semantic?.chunks || []).map((c) => [c.id, c]));
                const relationships = fnContent.semantic?.relationships || [];
                const assets = fnContent.assets?.images || [];
                const embeddings = fnContent.rag?.embeddings || [];
                for (const emb of embeddings) {
                    if (!emb.vector || emb.vector.length === 0)
                        continue;
                    const simScore = (0, embeddings_1.cosineSimilarity)(queryVector, emb.vector);
                    if (simScore >= minScore) {
                        const chunk = chunksMap.get(emb.chunkId);
                        const chunkText = chunk ? chunk.text : '';
                        const pageNum = chunk ? chunk.pageNumber : emb.source?.pageNumber || 1;
                        const sectionName = chunk ? chunk.section : emb.source?.section || 'General';
                        const sourceType = chunk ? chunk.sourceType : 'text';
                        // Gather relationships relevant to this chunk or page
                        const relatedRels = relationships.filter((r) => r.fromId === emb.chunkId || r.toId === emb.chunkId || r.fromId === `page-${fileUid}-p${pageNum}`);
                        const relatedAssets = assets.filter((a) => a.pageNumber === pageNum);
                        candidates.push({
                            rank: 0,
                            similarityScore: simScore,
                            chunkId: emb.chunkId,
                            topicUid: fileUid,
                            topicName,
                            pageNumber: pageNum,
                            section: sectionName,
                            sourceType,
                            text: chunkText,
                            embeddingId: emb.id,
                            vector: emb.vector,
                            relatedInformation: {
                                relationships: relatedRels,
                                assets: relatedAssets,
                            },
                        });
                    }
                }
            }
            catch (fileErr) {
                console.warn(`[RAG Retrieval] Could not process .fn file '${fileName}':`, fileErr);
            }
        }
    }
    // Sort descending by similarity score
    candidates.sort((a, b) => b.similarityScore - a.similarityScore);
    const topResults = candidates.slice(0, topK).map((item, index) => ({
        ...item,
        rank: index + 1,
    }));
    return { results: topResults, queryEmbedding };
}
/**
 * Builds structured RAG context string for prompt injection.
 */
async function buildRagContext(query, options = {}, provider) {
    const { results } = await retrieve(query, options, provider);
    if (results.length === 0) {
        return '';
    }
    let context = 'RELEVANT FLUXNOTES DATA\n\n';
    results.forEach((res) => {
        context += `[Topic: ${res.topicName}]\n`;
        context += `[Page: ${res.pageNumber}]\n`;
        context += `[Section: ${res.section}]\n`;
        context += `[Chunk: ${res.chunkId}]\n`;
        context += `${res.text}\n\n`;
    });
    context += 'END FLUXNOTES DATA\n';
    return context;
}
