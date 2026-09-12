import crypto from 'crypto';
import { NoteRecord, SubTopic } from '../types';
import {
  FnChunk,
  FnRelationship,
  FnPage,
  FnAsset,
} from '../utils/fnFormat';

export interface ChunkingResult {
  pages: FnPage[];
  chunks: FnChunk[];
  relationships: FnRelationship[];
  images: FnAsset[];
}

/**
 * Computes deterministic SHA-256 hash for chunk content.
 */
export function computeChunkHash(
  topicUid: string,
  pageNumber: number,
  section: string,
  sourceType: string,
  text: string,
): string {
  const payload = `${topicUid}:${pageNumber}:${section}:${sourceType}:${text.trim()}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}

/**
 * Document-aware semantic chunker for FluxNotes notes.
 */
export function chunkNoteRecord(note: NoteRecord): ChunkingResult {
  const topicUid = note.topicId;
  const topicName = note.topicName || 'Untitled Topic';

  const pages: FnPage[] = [];
  const chunks: FnChunk[] = [];
  const relationships: FnRelationship[] = [];
  const images: FnAsset[] = [];

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
  noteImages.forEach((img: string | { filePath: string; pageNumber: number }, idx: number) => {
    const imgPath = typeof img === 'string' ? img : img.filePath;
    const pageNum = typeof img === 'string' ? 1 : img.pageNumber || 1;
    const assetId = `img-${topicUid}-p${pageNum}-${idx}`;

    const asset: FnAsset = {
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
  const subTopics: SubTopic[] = note.subTopics || [];

  // Build page groupings based on images or subtopics
  const maxPage = Math.max(
    1,
    ...noteImages.map((i: string | { filePath: string; pageNumber: number }) => (typeof i === 'string' ? 1 : i.pageNumber || 1)),
    ...subTopics.map((s: SubTopic) => Number(s.pageNumber) || 1),
  );

  for (let pageNum = 1; pageNum <= maxPage; pageNum++) {
    const pageSubTopics = subTopics.filter((st: SubTopic) => Number(st.pageNumber) === pageNum);
    const pageImages = images.filter((img: FnAsset) => img.pageNumber === pageNum);

    const headings = pageSubTopics.flatMap((st: SubTopic) =>
      (st.names || []).map((name: string) => ({ text: name, level: 2 })),
    );

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

    const pageRecord: FnPage = {
      pageNumber: pageNum,
      text: sectionContent,
      headings,
      sections: [{ title: sectionTitle, content: sectionContent }],
      subTopics: pageSubTopics.map((st: SubTopic) => ({ names: st.names, pageNumber: st.pageNumber })),
      tables: [],
      equations: [],
      ocrBlocks: [],
      images: pageImages.map((img: FnAsset) => ({ id: img.id, filePath: img.filePath, pageNumber: img.pageNumber })),
    };
    pages.push(pageRecord);

    // Create chunks for SubTopics
    if (pageSubTopics.length > 0) {
      pageSubTopics.forEach((st: SubTopic, stIdx: number) => {
        const subTopicText = `Subtopic: ${st.names.join(' / ')} (Topic: ${topicName}, Page: ${pageNum})`;
        const chunkId = `chunk-${topicUid}-p${pageNum}-st-${stIdx}`;
        const contentHash = computeChunkHash(topicUid, pageNum, sectionTitle, 'subtopic', subTopicText);

        const chunk: FnChunk = {
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
      paragraphs.forEach((paragraph: string, pIdx: number) => {
        const chunkId = `chunk-${topicUid}-p${pageNum}-para-${pIdx}`;
        const contentHash = computeChunkHash(topicUid, pageNum, sectionTitle, 'paragraph', paragraph);

        const chunk: FnChunk = {
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
        pageImages.forEach((img: FnAsset) => {
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
