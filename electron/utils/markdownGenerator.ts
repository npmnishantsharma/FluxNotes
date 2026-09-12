import { NoteRecord, SubTopic } from '../types';

/**
 * Converts a NoteRecord or note topic metadata into clean, well-formatted Markdown text.
 */
export function generateNoteMarkdown(note: Partial<NoteRecord>): string {
  const title = note.topicName?.trim() || 'Untitled Notes';
  const subTopics: SubTopic[] = Array.isArray(note.subTopics) ? note.subTopics : [];
  const createdDate = note.timestamp ? new Date(note.timestamp).toLocaleDateString() : new Date().toLocaleDateString();

  let markdown = `# ${title}\n\n`;
  markdown += `> Generated on ${createdDate}\n\n`;

  if (subTopics.length > 0) {
    markdown += `## Outline & Subtopics\n\n`;
    subTopics.forEach((st) => {
      const names = Array.isArray(st.names) ? st.names.join(', ') : String(st.names || '');
      markdown += `- **Page ${st.pageNumber}**: ${names}\n`;
    });
    markdown += `\n---\n\n`;
  }

  if (Array.isArray(note.images) && note.images.length > 0) {
    markdown += `## Generated Note Pages & Diagrams\n\n`;
    note.images.forEach((img, index) => {
      const pageNum = typeof img === 'object' && img.pageNumber ? img.pageNumber : index + 1;
      const targetSubTopic = subTopics.find((st) => Number(st.pageNumber) === pageNum);
      const names = targetSubTopic ? (Array.isArray(targetSubTopic.names) ? targetSubTopic.names.join(' - ') : targetSubTopic.names) : `Page ${pageNum}`;

      markdown += `### Page ${pageNum}: ${names}\n\n`;
      markdown += `![Page ${pageNum} Note Image](fnd://${note.topicId || 'topic'}/${pageNum})\n\n`;
      markdown += `> **Diagram Asset (Page ${pageNum})**: Visual schematic representation for ${names}\n\n`;
      markdown += `![Page ${pageNum} Diagram Asset](fnd://${note.topicId || 'topic'}/${pageNum})\n\n`;
    });
  }

  if (note.aiResponse) {
    markdown += `## Summary & Key Notes\n\n${note.aiResponse}\n\n`;
  }

  return markdown.trim() + '\n';
}
