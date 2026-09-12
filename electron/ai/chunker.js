"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeChunkHash = computeChunkHash;
exports.chunkNoteRecord = chunkNoteRecord;
const crypto_1 = __importDefault(require("crypto"));
const helpers_1 = require("../utils/helpers");
const ocr_1 = require("./ocr");
const markdownGenerator_1 = require("../utils/markdownGenerator");
/**
 * Computes deterministic SHA-256 hash for chunk content.
 */
function computeChunkHash(topicUid, pageNumber, section, sourceType, text) {
    const payload = `${topicUid}:${pageNumber}:${section}:${sourceType}:${text.trim()}`;
    return crypto_1.default.createHash('sha256').update(payload).digest('hex');
}
/**
 * Document-aware semantic chunker for FluxNotes notes.
 */
function chunkNoteRecord(note) {
    const topicUid = note.topicId;
    const topicName = note.topicName || 'Untitled Topic';
    const pages = [];
    const chunks = [];
    const relationships = [];
    const images = [];
    // Relationship: Topic contains itself / root node
    relationships.push({
        id: `rel-topic-root-${topicUid}`,
        fromId: topicUid,
        toId: topicUid,
        type: 'contains',
        metadata: { topicName },
    });
    // Extract images
    const noteImages = note.images || [];
    noteImages.forEach((img, idx) => {
        const imgPath = typeof img === 'string' ? img : img.filePath;
        const pageNum = typeof img === 'string' ? 1 : img.pageNumber || 1;
        const assetId = `img-${topicUid}-p${pageNum}-${idx}`;
        const asset = {
            id: assetId,
            pageNumber: pageNum,
            filePath: imgPath,
            mimeType: imgPath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
            description: `Generated diagram page ${pageNum} for topic ${topicName}`,
        };
        images.push(asset);
        relationships.push({
            id: `rel-topic-img-${assetId}`,
            fromId: topicUid,
            toId: assetId,
            type: 'references',
            metadata: { pageNumber: pageNum },
        });
    });
    // Process subtopics & AI response text
    const rawResponseText = note.aiResponse || '';
    const subTopics = note.subTopics || [];
    // Build page groupings based on images or subtopics
    const maxPage = Math.max(1, ...noteImages.map((i) => (typeof i === 'string' ? 1 : i.pageNumber || 1)), ...subTopics.map((s) => Number(s.pageNumber) || 1));
    for (let pageNum = 1; pageNum <= maxPage; pageNum++) {
        const pageSubTopics = subTopics.filter((st) => Number(st.pageNumber) === pageNum);
        const pageImages = images.filter((img) => img.pageNumber === pageNum);
        const headings = pageSubTopics.flatMap((st) => (st.names || []).map((name) => ({ text: name, level: 2 })));
        const pageId = `page-${topicUid}-p${pageNum}`;
        relationships.push({
            id: `rel-topic-page-${pageId}`,
            fromId: topicUid,
            toId: pageId,
            type: 'contains',
            metadata: { pageNumber: pageNum },
        });
        // Extract text sections from raw AI response or subtopics
        const sectionTitle = pageSubTopics.length > 0 ? pageSubTopics[0].names.join(', ') : `Page ${pageNum}`;
        const sectionContent = rawResponseText ? `[Topic: ${topicName}] ${rawResponseText.substring(0, 1000)}` : `Notes for ${sectionTitle}`;
        // Perform OCR and diagram analysis on page images
        const pageOcrBlocks = [];
        pageImages.forEach((img, imgIdx) => {
            const diskPath = (0, helpers_1.fromLocalImageUrl)(img.filePath);
            const ocrAnalysis = (0, ocr_1.analyzeImageOcrAndDiagrams)(diskPath, pageNum, topicName);
            img.ocrText = ocrAnalysis.extractedText;
            pageOcrBlocks.push(...ocrAnalysis.ocrBlocks);
            // Separate OCR Chunk
            const ocrChunkId = `chunk-${topicUid}-p${pageNum}-ocr-${imgIdx}`;
            const ocrContentHash = computeChunkHash(topicUid, pageNum, sectionTitle, 'ocr', ocrAnalysis.extractedText);
            const ocrChunk = {
                id: ocrChunkId,
                topicUid,
                pageNumber: pageNum,
                section: sectionTitle,
                sourceType: 'ocr',
                text: ocrAnalysis.extractedText,
                contentHash: ocrContentHash,
            };
            chunks.push(ocrChunk);
            relationships.push({
                id: `rel-page-ocr-${ocrChunkId}`,
                fromId: pageId,
                toId: ocrChunkId,
                type: 'contains',
                metadata: { sourceType: 'ocr' },
            });
            relationships.push({
                id: `rel-ocr-img-${ocrChunkId}-${img.id}`,
                fromId: ocrChunkId,
                toId: img.id,
                type: 'derived_from',
                metadata: { pageNumber: pageNum },
            });
            // Separate Diagram Chunk
            const diagramChunkId = `chunk-${topicUid}-p${pageNum}-diagram-${imgIdx}`;
            const diagramContentHash = computeChunkHash(topicUid, pageNum, sectionTitle, 'diagram', ocrAnalysis.diagramDescription);
            const diagramChunk = {
                id: diagramChunkId,
                topicUid,
                pageNumber: pageNum,
                section: sectionTitle,
                sourceType: 'diagram',
                text: ocrAnalysis.diagramDescription,
                contentHash: diagramContentHash,
            };
            chunks.push(diagramChunk);
            relationships.push({
                id: `rel-page-diagram-${diagramChunkId}`,
                fromId: pageId,
                toId: diagramChunkId,
                type: 'contains',
                metadata: { sourceType: 'diagram' },
            });
            relationships.push({
                id: `rel-diagram-img-${diagramChunkId}-${img.id}`,
                fromId: diagramChunkId,
                toId: img.id,
                type: 'illustrates',
                metadata: { pageNumber: pageNum, labels: ocrAnalysis.diagramLabels },
            });
        });
        const pageMarkdown = (0, markdownGenerator_1.generateNoteMarkdown)({
            topicId: topicUid,
            topicName,
            subTopics: pageSubTopics,
            aiResponse: rawResponseText,
            images: pageImages.map((img) => ({ filePath: img.filePath, pageNumber: img.pageNumber })),
        });
        const pageRecord = {
            pageNumber: pageNum,
            text: sectionContent,
            markdown: pageMarkdown,
            headings,
            sections: [{ title: sectionTitle, content: sectionContent }],
            subTopics: pageSubTopics.map((st) => ({ names: st.names, pageNumber: st.pageNumber })),
            tables: [],
            equations: [],
            ocrBlocks: pageOcrBlocks,
            images: pageImages.map((img) => ({ id: img.id, filePath: img.filePath, pageNumber: img.pageNumber })),
        };
        pages.push(pageRecord);
        // Create chunks for SubTopics
        if (pageSubTopics.length > 0) {
            pageSubTopics.forEach((st, stIdx) => {
                const subTopicText = `Subtopic: ${st.names.join(' / ')} (Topic: ${topicName}, Page: ${pageNum})`;
                const chunkId = `chunk-${topicUid}-p${pageNum}-st-${stIdx}`;
                const contentHash = computeChunkHash(topicUid, pageNum, sectionTitle, 'subtopic', subTopicText);
                const chunk = {
                    id: chunkId,
                    topicUid,
                    pageNumber: pageNum,
                    section: sectionTitle,
                    sourceType: 'subtopic',
                    text: subTopicText,
                    contentHash,
                };
                chunks.push(chunk);
                relationships.push({
                    id: `rel-page-chunk-${chunkId}`,
                    fromId: pageId,
                    toId: chunkId,
                    type: 'contains',
                    metadata: { sourceType: 'subtopic' },
                });
            });
        }
        // Create chunk for Page Text Content
        if (sectionContent.trim().length > 0) {
            const paragraphs = sectionContent.split(/\n\n+/).filter((p) => p.trim().length > 0);
            paragraphs.forEach((paragraph, pIdx) => {
                const chunkId = `chunk-${topicUid}-p${pageNum}-para-${pIdx}`;
                const contentHash = computeChunkHash(topicUid, pageNum, sectionTitle, 'paragraph', paragraph);
                const chunk = {
                    id: chunkId,
                    topicUid,
                    pageNumber: pageNum,
                    section: sectionTitle,
                    sourceType: 'paragraph',
                    text: paragraph,
                    contentHash,
                };
                chunks.push(chunk);
                relationships.push({
                    id: `rel-page-chunk-${chunkId}`,
                    fromId: pageId,
                    toId: chunkId,
                    type: 'contains',
                    metadata: { sourceType: 'paragraph' },
                });
                // Relate chunk to images on the same page
                pageImages.forEach((img) => {
                    relationships.push({
                        id: `rel-chunk-img-${chunkId}-${img.id}`,
                        fromId: chunkId,
                        toId: img.id,
                        type: 'illustrates',
                        metadata: { pageNumber: pageNum },
                    });
                });
            });
        }
    }
    return {
        pages,
        chunks,
        relationships,
        images,
    };
}
