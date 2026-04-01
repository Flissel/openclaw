/**
 * Qdrant Vector Database Client
 *
 * Manages the hotel_knowledge collection for RAG.
 * Stores document chunks with metadata for filtered similarity search.
 */

import { QdrantClient } from "@qdrant/js-client-rest";
import { randomUUID } from "node:crypto";

export type DocumentCategory =
  | "hotel_info"
  | "events"
  | "faq"
  | "local"
  | "dining"
  | "transport"
  | "other";

export type ChunkPayload = {
  text: string;
  category: DocumentCategory;
  source_file: string;
  upload_date: number;
  chunk_index: number;
  hotel_id: string;
  document_id: string;
};

export type SearchResult = {
  id: string;
  text: string;
  category: DocumentCategory;
  source_file: string;
  score: number;
};

export class HotelKnowledgeDB {
  private client: QdrantClient;
  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly qdrantUrl: string,
    private readonly collection: string,
    private readonly vectorSize: number,
  ) {
    this.client = new QdrantClient({ url: qdrantUrl });
  }

  private async ensureCollection(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInit();
    return this.initPromise;
  }

  private async doInit(): Promise<void> {
    const collections = await this.client.getCollections();
    const exists = collections.collections.some((c) => c.name === this.collection);
    if (!exists) {
      await this.client.createCollection(this.collection, {
        vectors: { size: this.vectorSize, distance: "Cosine" },
      });
      // Create payload indexes for filtering
      await this.client.createPayloadIndex(this.collection, {
        field_name: "category",
        field_schema: "keyword",
      });
      await this.client.createPayloadIndex(this.collection, {
        field_name: "hotel_id",
        field_schema: "keyword",
      });
      await this.client.createPayloadIndex(this.collection, {
        field_name: "document_id",
        field_schema: "keyword",
      });
    }
  }

  async upsert(chunks: Array<{ vector: number[]; payload: ChunkPayload }>): Promise<string[]> {
    await this.ensureCollection();
    const points = chunks.map((chunk) => ({
      id: randomUUID(),
      vector: chunk.vector,
      payload: chunk.payload as Record<string, unknown>,
    }));
    await this.client.upsert(this.collection, { points });
    return points.map((p) => p.id);
  }

  async search(
    vector: number[],
    topK: number = 5,
    filter?: { category?: DocumentCategory; hotel_id?: string },
  ): Promise<SearchResult[]> {
    await this.ensureCollection();

    const must: Array<Record<string, unknown>> = [];
    if (filter?.category) {
      must.push({ key: "category", match: { value: filter.category } });
    }
    if (filter?.hotel_id) {
      must.push({ key: "hotel_id", match: { value: filter.hotel_id } });
    }

    const results = await this.client.search(this.collection, {
      vector,
      limit: topK,
      with_payload: true,
      filter: must.length > 0 ? { must } : undefined,
    });

    return results.map((r) => ({
      id: typeof r.id === "string" ? r.id : String(r.id),
      text: (r.payload?.text as string) ?? "",
      category: (r.payload?.category as DocumentCategory) ?? "other",
      source_file: (r.payload?.source_file as string) ?? "",
      score: r.score,
    }));
  }

  async deleteByDocumentId(documentId: string): Promise<void> {
    await this.ensureCollection();
    await this.client.delete(this.collection, {
      filter: {
        must: [{ key: "document_id", match: { value: documentId } }],
      },
    });
  }

  async listDocuments(hotelId: string): Promise<Array<{ document_id: string; source_file: string; category: string; upload_date: number; chunk_count: number }>> {
    await this.ensureCollection();

    // Scroll through all points to aggregate document info
    const docs = new Map<string, { source_file: string; category: string; upload_date: number; chunk_count: number }>();

    let offset: string | number | undefined = undefined;
    let hasMore = true;
    while (hasMore) {
      const result = await this.client.scroll(this.collection, {
        filter: { must: [{ key: "hotel_id", match: { value: hotelId } }] },
        limit: 100,
        offset,
        with_payload: true,
      });

      for (const point of result.points) {
        const docId = point.payload?.document_id as string;
        if (!docId) continue;
        const existing = docs.get(docId);
        if (existing) {
          existing.chunk_count++;
        } else {
          docs.set(docId, {
            source_file: (point.payload?.source_file as string) ?? "",
            category: (point.payload?.category as string) ?? "other",
            upload_date: (point.payload?.upload_date as number) ?? 0,
            chunk_count: 1,
          });
        }
      }

      offset = result.next_page_offset ?? undefined;
      hasMore = offset !== undefined;
    }

    return Array.from(docs.entries()).map(([document_id, info]) => ({
      document_id,
      ...info,
    }));
  }
}
