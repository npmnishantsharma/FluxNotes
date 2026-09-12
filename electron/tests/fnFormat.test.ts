import assert from 'assert';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  serializeFn,
  deserializeFn,
  writeFnFile,
  readFnFile,
  validateFnFile,
  getRawBinaryInfo,
  FnFileContent,
  FN_MAGIC,
  CURRENT_SCHEMA_VERSION,
} from '../utils/fnFormat';
import {
  cosineSimilarity,
  generateLocalPseudoEmbedding,
  HttpEmbeddingProvider,
  reindexTopicEmbeddings,
} from '../ai/embeddings';
import { chunkNoteRecord, computeChunkHash } from '../ai/chunker';
import { NoteRecord } from '../types';

async function runTests() {
  console.log('🧪 Starting FluxNotes .fn Binary & RAG Unit Tests...\n');

  // Test 1: Cosine Similarity
  console.log('Test 1: Manual Cosine Similarity...');
  const vecA = [1, 0, 0];
  const vecB = [1, 0, 0];
  const vecC = [0, 1, 0];
  assert.strictEqual(cosineSimilarity(vecA, vecB), 1.0, 'Identical vectors should have similarity 1.0');
  assert.strictEqual(cosineSimilarity(vecA, vecC), 0.0, 'Orthogonal vectors should have similarity 0.0');
  assert.strictEqual(cosineSimilarity([0, 0, 0], vecA), 0.0, 'Zero vector should yield similarity 0.0');
  assert.throws(() => cosineSimilarity([1, 2], [1, 2, 3]), /Vector dimensions do not match/, 'Mismatched dimensions should throw error');
  console.log('  ✓ Passed\n');

  // Test 2: Chunk Hashing & Determinism
  console.log('Test 2: Chunk Hashing...');
  const hash1 = computeChunkHash('topic-123', 1, 'Section 1', 'paragraph', 'Hello World');
  const hash2 = computeChunkHash('topic-123', 1, 'Section 1', 'paragraph', 'Hello World');
  const hash3 = computeChunkHash('topic-123', 1, 'Section 1', 'paragraph', 'Hello World Different');
  assert.strictEqual(hash1, hash2, 'Identical inputs must yield identical hashes');
  assert.notStrictEqual(hash1, hash3, 'Different inputs must yield different hashes');
  console.log('  ✓ Passed\n');

  // Test 3: Binary Serialization Roundtrip
  console.log('Test 3: Binary Serialization & Deserialization...');
  const sampleContent: FnFileContent = {
    header: {
      magic: FN_MAGIC,
      schemaVersion: CURRENT_SCHEMA_VERSION,
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

  const serializedBuf = serializeFn(sampleContent);
  const deserializedContent = deserializeFn(serializedBuf);

  assert.strictEqual(deserializedContent.header.magic, FN_MAGIC);
  assert.strictEqual(deserializedContent.header.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.strictEqual(deserializedContent.topic.topicName, 'AC Generator Test Topic');
  assert.strictEqual(deserializedContent.document.pages.length, 1);
  assert.strictEqual(deserializedContent.semantic.chunks.length, 1);
  assert.strictEqual(deserializedContent.semantic.relationships.length, 1);
  assert.strictEqual(deserializedContent.rag.embeddings.length, 1);

  // Check vector preservation
  const originalVec = sampleContent.rag.embeddings[0].vector;
  const deserializedVec = deserializedContent.rag.embeddings[0].vector;
  for (let i = 0; i < originalVec.length; i++) {
    assert.ok(Math.abs(originalVec[i] - deserializedVec[i]) < 1e-5, `Vector dim ${i} should be preserved`);
  }
  console.log('  ✓ Passed\n');

  // Test 4: Atomic Write & Read to Disk
  console.log('Test 4: Atomic Binary Disk Operations...');
  const tempTestDir = path.join(__dirname, 'temp_test_dir');
  const tempFilePath = path.join(tempTestDir, 'sample_topic.fn');

  await writeFnFile(tempFilePath, sampleContent);
  assert.ok(fs.existsSync(tempFilePath), '.fn file should exist on disk');

  const readContent = await readFnFile(tempFilePath);
  assert.strictEqual(readContent.topic.topicName, 'AC Generator Test Topic');

  const rawInfo = await getRawBinaryInfo(tempFilePath);
  assert.strictEqual(rawInfo.magic, FN_MAGIC);
  assert.strictEqual(rawInfo.checksumValid, true, 'SHA-256 Checksum should be valid');

  const validation = await validateFnFile(tempFilePath);
  assert.strictEqual(validation.valid, true, 'Validation should pass cleanly');

  // Cleanup
  await fs.promises.rm(tempTestDir, { recursive: true, force: true });
  console.log('  ✓ Passed\n');

  // Test 5: Re-indexing & Embedding Reuse
  console.log('Test 5: Re-indexing & Embedding Reuse...');
  const provider = new HttpEmbeddingProvider({ dimensions: 4 });
  const sampleNote: NoteRecord = {
    topicId: 'topic-reindex-1',
    topicName: 'Reindex Test',
    aiResponse: 'Paragraph 1 text.\n\nParagraph 2 text.',
    subTopics: [{ names: ['Subtopic 1'], pageNumber: 1 }],
  };

  const chunkingResult1 = chunkNoteRecord(sampleNote);
  const embeddings1 = await reindexTopicEmbeddings(null, chunkingResult1.chunks, provider);
  assert.strictEqual(embeddings1.length, chunkingResult1.chunks.length);

  // Re-index with same unchanged note -> embeddings should be reused
  const fakeFileContent: FnFileContent = {
    header: { magic: FN_MAGIC, schemaVersion: 1, topicUid: 'topic-reindex-1', createdTimestamp: Date.now(), updatedTimestamp: Date.now() },
    topic: { topicId: 'topic-reindex-1', topicName: 'Reindex Test', createdTimestamp: Date.now(), updatedTimestamp: Date.now() },
    document: { pages: chunkingResult1.pages },
    assets: { images: [] },
    semantic: { chunks: chunkingResult1.chunks, relationships: chunkingResult1.relationships },
    rag: { model: provider.getModelName(), dimensions: 4, modality: 'text', embeddings: embeddings1 },
  };

  const embeddings2 = await reindexTopicEmbeddings(fakeFileContent, chunkingResult1.chunks, provider);
  assert.strictEqual(embeddings2.length, embeddings1.length);
  assert.strictEqual(embeddings2[0].id, embeddings1[0].id, 'Unchanged chunk should reuse embedding');
  console.log('  ✓ Passed\n');

  console.log('✅ ALL TESTS PASSED SUCCESSFULLY!');
}

runTests().catch((err) => {
  console.error('❌ Test failed with error:', err);
  process.exit(1);
});
