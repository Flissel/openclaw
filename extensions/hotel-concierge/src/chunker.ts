/**
 * Text Chunker
 *
 * Splits text into overlapping chunks suitable for embedding.
 * Uses character-based splitting with paragraph awareness.
 */

export type TextChunk = {
  text: string;
  index: number;
};

const DEFAULT_CHUNK_SIZE = 1500; // ~375 tokens (rough 4:1 char:token ratio)
const DEFAULT_OVERLAP = 200;

export function chunkText(
  text: string,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
  overlap: number = DEFAULT_OVERLAP,
): TextChunk[] {
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  // If text fits in one chunk, return it directly
  if (cleaned.length <= chunkSize) {
    return [{ text: cleaned, index: 0 }];
  }

  const chunks: TextChunk[] = [];
  let start = 0;
  let index = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);

    // Try to break at paragraph boundary
    if (end < cleaned.length) {
      const paragraphBreak = cleaned.lastIndexOf("\n\n", end);
      if (paragraphBreak > start + chunkSize * 0.5) {
        end = paragraphBreak + 2;
      } else {
        // Try sentence boundary
        const sentenceBreak = cleaned.lastIndexOf(". ", end);
        if (sentenceBreak > start + chunkSize * 0.5) {
          end = sentenceBreak + 2;
        }
      }
    }

    const chunk = cleaned.slice(start, end).trim();
    if (chunk.length > 0) {
      chunks.push({ text: chunk, index });
      index++;
    }

    start = end - overlap;
    if (start >= cleaned.length) break;
  }

  return chunks;
}
