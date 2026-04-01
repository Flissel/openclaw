/**
 * Document Processor
 *
 * Parses PDF, DOCX, TXT, and CSV files into text,
 * then chunks them for embedding and storage in Qdrant.
 */

import { chunkText, type TextChunk } from "./chunker.js";

export type ProcessedDocument = {
  chunks: TextChunk[];
  sourceText: string;
  pageCount?: number;
};

/**
 * Extract text from a file buffer based on its MIME type or extension.
 */
export async function extractText(
  buffer: Buffer,
  filename: string,
): Promise<string> {
  const ext = filename.toLowerCase().split(".").pop() ?? "";

  switch (ext) {
    case "pdf":
      return extractPdf(buffer);
    case "docx":
      return extractDocx(buffer);
    case "txt":
    case "md":
    case "csv":
      return buffer.toString("utf-8");
    default:
      throw new Error(`Unsupported file type: .${ext}. Supported: pdf, docx, txt, md, csv`);
  }
}

async function extractPdf(buffer: Buffer): Promise<string> {
  const pdfParse = (await import("pdf-parse")).default;
  const result = await pdfParse(buffer);
  return result.text;
}

async function extractDocx(buffer: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

/**
 * Process a document: extract text and split into chunks.
 */
export async function processDocument(
  buffer: Buffer,
  filename: string,
): Promise<ProcessedDocument> {
  const sourceText = await extractText(buffer, filename);
  const chunks = chunkText(sourceText);
  return { chunks, sourceText };
}
