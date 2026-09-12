"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const fnFormat_1 = require("../utils/fnFormat");
const embeddings_1 = require("../ai/embeddings");
const chunker_1 = require("../ai/chunker");
async function runTests() {
    console.log('🧪 Starting FluxNotes .fn Binary & RAG Unit Tests...\n');
    // Test 1: Cosine Similarity
    console.log('Test 1: Manual Cosine Similarity...');
    const vecA = [1, 0, 0];
    const vecB = [1, 0, 0];
    const vecC = [0, 1, 0];
    assert_1.default.strictEqual((0, embeddings_1.cosineSimilarity)(vecA, vecB), 1.0, 'Identical vectors should have similarity 1.0');
    assert_1.default.strictEqual((0, embeddings_1.cosineSimilarity)(vecA, vecC), 0.0, 'Orthogonal vectors should have similarity 0.0');
    assert_1.default.strictEqual((0, embeddings_1.cosineSimilarity)([0, 0, 0], vecA), 0.0, 'Zero vector should yield similarity 0.0');
    assert_1.default.throws(() => (0, embeddings_1.cosineSimilarity)([1, 2], [1, 2, 3]), /Vector dimensions do not match/, 'Mismatched dimensions should throw error');
    console.log('  ✓ Passed\n');
    // Test 2: Chunk Hashing & Determinism
    console.log('Test 2: Chunk Hashing...');
    const hash1 = (0, chunker_1.computeChunkHash)('topic-123', 1, 'Section 1', 'paragraph', 'Hello World');
    const hash2 = (0, chunker_1.computeChunkHash)('topic-123', 1, 'Section 1', 'paragraph', 'Hello World');
    const hash3 = (0, chunker_1.computeChunkHash)('topic-123', 1, 'Section 1', 'paragraph', 'Hello World Different');
    assert_1.default.strictEqual(hash1, hash2, 'Identical inputs must yield identical hashes');
    assert_1.default.notStrictEqual(hash1, hash3, 'Different inputs must yield different hashes');
    console.log('  ✓ Passed\n');
    // Test 3: Binary Serialization Roundtrip
    console.log('Test 3: Binary Serialization & Deserialization...');
    const sampleContent = {
        header: {
            magic: fnFormat_1.FN_MAGIC,
            schemaVersion: fnFormat_1.CURRENT_SCHEMA_VERSION,
            topicUid: 'test-topic-uid-1234567890123456789',
            createdTimestamp: 1700000000000,
            updatedTimestamp: 1700000000000,
        },
        topic: {
            topicId: 'test-topic-uid-1234567890123456789',
            topicName: 'AC Generator Test Topic',
            createdTimestamp: 1700000000000,
            updatedTimestamp: 1700000000000,
        },
        document: {
            pages: [
                {
                    pageNumber: 1,
                    text: 'AC Generator working principle and diagram.',
                    headings: [{ text: 'Working Principle', level: 2 }],
                    sections: [{ title: 'Working Principle', content: 'AC Generator uses electromagnetic induction.' }],
                    subTopics: [{ names: ['Working Principle'], pageNumber: 1 }],
                    tables: [],
                    equations: [],
                    ocrBlocks: [],
                    images: [],
                },
            ],
        },
        assets: {
            images: [
                {
                    id: 'img-1',
                    pageNumber: 1,
                    filePath: '/images/diagram.png',
                    mimeType: 'image/png',
                    description: 'AC Generator Diagram',
                },
            ],
        },
        semantic: {
            chunks: [
                {
                    id: 'chunk-1',
                    topicUid: 'test-topic-uid-1234567890123456789',
                    pageNumber: 1,
                    section: 'Working Principle',
                    sourceType: 'paragraph',
                    text: 'AC Generator uses electromagnetic induction.',
                    contentHash: 'hash-123',
                },
            ],
            relationships: [
                {
                    id: 'rel-1',
                    fromId: 'chunk-1',
                    toId: 'img-1',
                    type: 'illustrates',
                },
            ],
        },
        rag: {
            model: 'text-embedding-3-small',
            dimensions: 4,
            modality: 'text',
            embeddings: [
                {
                    id: 'emb-1',
                    chunkId: 'chunk-1',
                    model: 'text-embedding-3-small',
                    dimensions: 4,
                    modality: 'text',
                    vector: [0.1, -0.2, 0.3, 0.4],
                    source: { pageNumber: 1, section: 'Working Principle' },
                    contentHash: 'hash-123',
                },
            ],
        },
    };
    const serializedBuf = (0, fnFormat_1.serializeFn)(sampleContent);
    const deserializedContent = (0, fnFormat_1.deserializeFn)(serializedBuf);
    assert_1.default.strictEqual(deserializedContent.header.magic, fnFormat_1.FN_MAGIC);
    assert_1.default.strictEqual(deserializedContent.header.schemaVersion, fnFormat_1.CURRENT_SCHEMA_VERSION);
    assert_1.default.strictEqual(deserializedContent.topic.topicName, 'AC Generator Test Topic');
    assert_1.default.strictEqual(deserializedContent.document.pages.length, 1);
    assert_1.default.strictEqual(deserializedContent.semantic.chunks.length, 1);
    assert_1.default.strictEqual(deserializedContent.semantic.relationships.length, 1);
    assert_1.default.strictEqual(deserializedContent.rag.embeddings.length, 1);
    // Check vector preservation
    const originalVec = sampleContent.rag.embeddings[0].vector;
    const deserializedVec = deserializedContent.rag.embeddings[0].vector;
    for (let i = 0; i < originalVec.length; i++) {
        assert_1.default.ok(Math.abs(originalVec[i] - deserializedVec[i]) < 1e-5, `Vector dim ${i} should be preserved`);
    }
    console.log('  ✓ Passed\n');
    // Test 4: Atomic Write & Read to Disk
    console.log('Test 4: Atomic Binary Disk Operations...');
    const tempTestDir = path_1.default.join(__dirname, 'temp_test_dir');
    const tempFilePath = path_1.default.join(tempTestDir, 'sample_topic.fn');
    await (0, fnFormat_1.writeFnFile)(tempFilePath, sampleContent);
    assert_1.default.ok(fs_1.default.existsSync(tempFilePath), '.fn file should exist on disk');
    const readContent = await (0, fnFormat_1.readFnFile)(tempFilePath);
    assert_1.default.strictEqual(readContent.topic.topicName, 'AC Generator Test Topic');
    const rawInfo = await (0, fnFormat_1.getRawBinaryInfo)(tempFilePath);
    assert_1.default.strictEqual(rawInfo.magic, fnFormat_1.FN_MAGIC);
    assert_1.default.strictEqual(rawInfo.checksumValid, true, 'SHA-256 Checksum should be valid');
    const validation = await (0, fnFormat_1.validateFnFile)(tempFilePath);
    assert_1.default.strictEqual(validation.valid, true, 'Validation should pass cleanly');
    // Cleanup
    await fs_1.default.promises.rm(tempTestDir, { recursive: true, force: true });
    console.log('  ✓ Passed\n');
    // Test 5: Re-indexing & Embedding Reuse
    console.log('Test 5: Re-indexing & Embedding Reuse...');
    const provider = new embeddings_1.HttpEmbeddingProvider({ dimensions: 4 });
    const sampleNote = {
        topicId: 'topic-reindex-1',
        topicName: 'Reindex Test',
        aiResponse: 'Paragraph 1 text.\n\nParagraph 2 text.',
        subTopics: [{ names: ['Subtopic 1'], pageNumber: 1 }],
    };
    const chunkingResult1 = (0, chunker_1.chunkNoteRecord)(sampleNote);
    const embeddings1 = await (0, embeddings_1.reindexTopicEmbeddings)(null, chunkingResult1.chunks, provider);
    assert_1.default.strictEqual(embeddings1.length, chunkingResult1.chunks.length);
    // Re-index with same unchanged note -> embeddings should be reused
    const fakeFileContent = {
        header: { magic: fnFormat_1.FN_MAGIC, schemaVersion: 1, topicUid: 'topic-reindex-1', createdTimestamp: Date.now(), updatedTimestamp: Date.now() },
        topic: { topicId: 'topic-reindex-1', topicName: 'Reindex Test', createdTimestamp: Date.now(), updatedTimestamp: Date.now() },
        document: { pages: chunkingResult1.pages },
        assets: { images: [] },
        semantic: { chunks: chunkingResult1.chunks, relationships: chunkingResult1.relationships },
        rag: { model: provider.getModelName(), dimensions: 4, modality: 'text', embeddings: embeddings1 },
    };
    const embeddings2 = await (0, embeddings_1.reindexTopicEmbeddings)(fakeFileContent, chunkingResult1.chunks, provider);
    assert_1.default.strictEqual(embeddings2.length, embeddings1.length);
    assert_1.default.strictEqual(embeddings2[0].id, embeddings1[0].id, 'Unchanged chunk should reuse embedding');
    console.log('  ✓ Passed\n');
    // Test 6: Obfuscation of JSON Structure in .fn File
    console.log('Test 6: Hex Obfuscation of JSON Payload Structure...');
    const serialized = (0, fnFormat_1.serializeFn)(sampleContent);
    // Extract payload section buffer (beyond the 64-byte binary header)
    const payloadSectionBuf = serialized.subarray(64, serialized.length - 32);
    const payloadStr = payloadSectionBuf.toString('ascii');
    // Verify no raw JSON object brackets exist in section payloads
    assert_1.default.strictEqual(payloadStr.includes('{"topicId"'), false, 'Serialized payloads must not contain plain JSON syntax');
    assert_1.default.strictEqual(payloadStr.includes('"topicName"'), false, 'Serialized payloads must not expose field names in plaintext');
    // Verify deserialization decodes payload properly
    const decodedContent = (0, fnFormat_1.deserializeFn)(serialized);
    assert_1.default.strictEqual(decodedContent.topic.topicId, sampleContent.topic.topicId);
    console.log('  ✓ Passed\n');
    // Test 7: OCR Text & Diagram Chunking Separation
    console.log('Test 7: OCR Text & Diagram Separation in Chunker...');
    const noteWithImage = {
        topicId: 'topic-ocr-diagram-1',
        topicName: 'Solar Panel System',
        aiResponse: 'Solar panels convert sunlight to electricity.',
        subTopics: [{ names: ['Photovoltaic Effect'], pageNumber: 1 }],
        images: [{ filePath: '/non/existent/diagram_solar.png', pageNumber: 1 }],
    };
    const ocrChunkResult = (0, chunker_1.chunkNoteRecord)(noteWithImage);
    assert_1.default.ok(ocrChunkResult.chunks.some((c) => c.sourceType === 'ocr'), 'Must contain separate OCR sourceType chunk');
    assert_1.default.ok(ocrChunkResult.chunks.some((c) => c.sourceType === 'diagram'), 'Must contain separate Diagram sourceType chunk');
    const ocrChunk = ocrChunkResult.chunks.find((c) => c.sourceType === 'ocr');
    const diagramChunk = ocrChunkResult.chunks.find((c) => c.sourceType === 'diagram');
    assert_1.default.ok(ocrChunk.text.length > 0, 'OCR chunk must contain extracted text');
    assert_1.default.ok(diagramChunk.text.length > 0, 'Diagram chunk must contain diagram description');
    assert_1.default.ok(ocrChunkResult.relationships.some((r) => r.type === 'derived_from' && r.fromId === ocrChunk.id), 'Must contain relationship linking OCR chunk to image asset');
    assert_1.default.ok(ocrChunkResult.relationships.some((r) => r.type === 'illustrates' && r.fromId === diagramChunk.id), 'Must contain relationship linking Diagram chunk to image asset');
    console.log('  ✓ Passed\n');
    console.log('✅ ALL TESTS PASSED SUCCESSFULLY!');
}
runTests().catch((err) => {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
});
