"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HttpEmbeddingProvider = void 0;
exports.generateLocalPseudoEmbedding = generateLocalPseudoEmbedding;
exports.cosineSimilarity = cosineSimilarity;
exports.reindexTopicEmbeddings = reindexTopicEmbeddings;
const crypto_1 = __importDefault(require("crypto"));
/**
 * Deterministic local feature hashing vector generator.
 * Provides fallback float vector embeddings for offline/local operation.
 */
function generateLocalPseudoEmbedding(text, dimensions = 1536) {
    const vector = new Array(dimensions).fill(0);
    const words = text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(Boolean);
    if (words.length === 0)
        return vector;
    words.forEach((word) => {
        const hash = crypto_1.default.createHash('md5').update(word).digest();
        const idx1 = hash.readUInt16BE(0) % dimensions;
        const idx2 = hash.readUInt16BE(2) % dimensions;
        const idx3 = hash.readUInt16BE(4) % dimensions;
        const sign1 = (hash[6] & 1) === 0 ? 1 : -1;
        const sign2 = (hash[7] & 1) === 0 ? 1 : -1;
        const sign3 = (hash[8] & 1) === 0 ? 1 : -1;
        vector[idx1] += sign1 * 0.5;
        vector[idx2] += sign2 * 0.3;
        vector[idx3] += sign3 * 0.2;
    });
    // Normalize L2
    let norm = 0;
    for (let i = 0; i < dimensions; i++) {
        norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < dimensions; i++) {
            vector[i] /= norm;
        }
    }
    return vector;
}
/**
 * Standard HTTP Embedding Provider using native fetch.
 */
class HttpEmbeddingProvider {
    apiUrl;
    apiKey;
    model;
    dimensions;
    constructor(options = {}) {
        this.apiUrl = options.apiUrl || process.env.EMBEDDING_API_URL || '';
        this.apiKey = options.apiKey || process.env.EMBEDDING_API_KEY || '';
        this.model = options.model || process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
        this.dimensions = options.dimensions || 1536;
    }
    getDimensions() {
        return this.dimensions;
    }
    getModelName() {
        return this.model;
    }
    async embed(text) {
        const results = await this.embedBatch([text]);
        return results[0] || generateLocalPseudoEmbedding(text, this.dimensions);
    }
    async embedBatch(texts) {
        if (texts.length === 0)
            return [];
        if (!this.apiUrl) {
            // Fall back to local pseudo-embeddings if no remote API URL is specified
            return texts.map((t) => generateLocalPseudoEmbedding(t, this.dimensions));
        }
        try {
            const response = await fetch(this.apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
                },
                body: JSON.stringify({
                    model: this.model,
                    input: texts,
                }),
            });
            if (!response.ok) {
                console.warn(`[EmbeddingProvider] HTTP API call returned ${response.status}. Using local fallback.`);
                return texts.map((t) => generateLocalPseudoEmbedding(t, this.dimensions));
            }
            const json = (await response.json());
            if (json.data && Array.isArray(json.data)) {
                return json.data.map((item, idx) => Array.isArray(item.embedding)
                    ? item.embedding
                    : generateLocalPseudoEmbedding(texts[idx], this.dimensions));
            }
            return texts.map((t) => generateLocalPseudoEmbedding(t, this.dimensions));
        }
        catch (err) {
            console.warn('[EmbeddingProvider] Fetch error during embedding call. Using local fallback:', err);
            return texts.map((t) => generateLocalPseudoEmbedding(t, this.dimensions));
        }
    }
}
exports.HttpEmbeddingProvider = HttpEmbeddingProvider;
/**
 * Pure manual Cosine Similarity implementation.
 */
function cosineSimilarity(a, b) {
    if (a.length !== b.length) {
        throw new Error(`Vector dimensions do not match: ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) {
        return 0;
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
/**
 * Re-indexes embeddings incrementally using chunk content hashes.
 * Reuses existing embeddings if chunk hash is unchanged.
 */
async function reindexTopicEmbeddings(existingContent, newChunks, provider) {
    const existingEmbeddingsMap = new Map();
    if (existingContent && existingContent.rag && Array.isArray(existingContent.rag.embeddings)) {
        existingContent.rag.embeddings.forEach((emb) => {
            existingEmbeddingsMap.set(emb.chunkId, emb);
        });
    }
    const chunksToEmbed = [];
    const finalEmbeddings = [];
    for (const chunk of newChunks) {
        const existingEmb = existingEmbeddingsMap.get(chunk.id);
        if (existingEmb && existingEmb.contentHash === chunk.contentHash) {
            // Content hash matches: reuse existing vector embedding
            finalEmbeddings.push(existingEmb);
        }
        else {
            chunksToEmbed.push(chunk);
        }
    }
    if (chunksToEmbed.length > 0) {
        const texts = chunksToEmbed.map((c) => c.text);
        const newVectors = await provider.embedBatch(texts);
        chunksToEmbed.forEach((chunk, idx) => {
            const vector = newVectors[idx] || generateLocalPseudoEmbedding(chunk.text, provider.getDimensions());
            const embeddingRecord = {
                id: `emb-${chunk.id}`,
                chunkId: chunk.id,
                model: provider.getModelName(),
                dimensions: provider.getDimensions(),
                modality: 'text',
                vector,
                source: {
                    pageNumber: chunk.pageNumber,
                    section: chunk.section,
                },
                contentHash: chunk.contentHash,
            };
            finalEmbeddings.push(embeddingRecord);
        });
    }
    return finalEmbeddings;
}
