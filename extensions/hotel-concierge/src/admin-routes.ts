/**
 * Admin HTTP Routes
 *
 * Protected routes (auth: "gateway") for hotel staff.
 * Provides document upload, document listing, and guest management.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AllowlistStore } from "./allowlist-store.js";
import type { AllowlistSync } from "./allowlist-sync.js";
import type { HotelKnowledgeDB, DocumentCategory } from "./qdrant-client.js";
import type { EmbeddingClient } from "./embeddings.js";
import { processDocument } from "./document-processor.js";
import { randomUUID } from "node:crypto";

const MAX_UPLOAD_SIZE = 20 * 1024 * 1024; // 20 MB

function parseBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPLOAD_SIZE) {
        reject(new Error("File too large (max 20 MB)"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const VALID_CATEGORIES: DocumentCategory[] = [
  "hotel_info", "events", "faq", "local", "dining", "transport", "other",
];

export function createAdminHandler(
  store: AllowlistStore,
  sync: AllowlistSync,
  knowledgeDB: HotelKnowledgeDB,
  embeddingClient: EmbeddingClient,
  hotelId: string,
  staticDir: string,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "");

    // GET /concierge/admin -> serve admin page
    if (req.method === "GET" && path === "/concierge/admin") {
      const html = readFileSync(join(staticDir, "admin.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    // POST /concierge/admin/upload -> handle document upload
    if (req.method === "POST" && path === "/concierge/admin/upload") {
      try {
        const contentType = req.headers["content-type"] ?? "";

        if (!contentType.includes("multipart/form-data")) {
          sendJson(res, 400, { error: "Content-Type must be multipart/form-data" });
          return true;
        }

        const { filename, fileBuffer, category } = await parseMultipartUpload(req);

        if (!fileBuffer || !filename) {
          sendJson(res, 400, { error: "No file uploaded" });
          return true;
        }

        const docCategory = VALID_CATEGORIES.includes(category as DocumentCategory)
          ? (category as DocumentCategory)
          : "other";

        // Process document
        const processed = await processDocument(fileBuffer, filename);
        if (processed.chunks.length === 0) {
          sendJson(res, 400, { error: "Dokument enthält keinen extrahierbaren Text." });
          return true;
        }

        // Embed all chunks
        const texts = processed.chunks.map((c) => c.text);
        const vectors = await embeddingClient.embedBatch(texts);

        // Store in Qdrant
        const documentId = randomUUID();
        const uploadDate = Date.now();
        const qdrantChunks = processed.chunks.map((chunk, i) => ({
          vector: vectors[i],
          payload: {
            text: chunk.text,
            category: docCategory,
            source_file: filename,
            upload_date: uploadDate,
            chunk_index: chunk.index,
            hotel_id: hotelId,
            document_id: documentId,
          },
        }));

        await knowledgeDB.upsert(qdrantChunks);

        sendJson(res, 200, {
          success: true,
          document_id: documentId,
          filename,
          category: docCategory,
          chunks: processed.chunks.length,
          message: `Dokument "${filename}" erfolgreich hochgeladen (${processed.chunks.length} Chunks).`,
        });
        return true;
      } catch (err) {
        sendJson(res, 500, { error: `Upload fehlgeschlagen: ${String(err)}` });
        return true;
      }
    }

    // GET /concierge/admin/documents -> list documents
    if (req.method === "GET" && path === "/concierge/admin/documents") {
      try {
        const docs = await knowledgeDB.listDocuments(hotelId);
        sendJson(res, 200, { documents: docs });
        return true;
      } catch (err) {
        sendJson(res, 500, { error: `Fehler beim Laden: ${String(err)}` });
        return true;
      }
    }

    // DELETE /concierge/admin/documents/:id -> delete document
    if (req.method === "DELETE" && path.startsWith("/concierge/admin/documents/")) {
      try {
        const docId = path.split("/").pop() ?? "";
        if (!docId) {
          sendJson(res, 400, { error: "Document ID required" });
          return true;
        }
        await knowledgeDB.deleteByDocumentId(docId);
        sendJson(res, 200, { success: true, message: "Dokument gelöscht." });
        return true;
      } catch (err) {
        sendJson(res, 500, { error: `Löschen fehlgeschlagen: ${String(err)}` });
        return true;
      }
    }

    // GET /concierge/admin/guests -> list guests
    if (req.method === "GET" && path === "/concierge/admin/guests") {
      const guests = store.getAllGuests();
      const now = Date.now();
      const enriched = guests.map((g) => ({
        ...g,
        active: g.expires_at > now,
        expires_at_iso: new Date(g.expires_at).toISOString(),
        registered_at_iso: new Date(g.registered_at).toISOString(),
      }));
      sendJson(res, 200, { guests: enriched });
      return true;
    }

    // DELETE /concierge/admin/guests/:phone -> remove guest
    if (req.method === "DELETE" && path.startsWith("/concierge/admin/guests/")) {
      try {
        const phone = decodeURIComponent(path.split("/").pop() ?? "");
        if (!phone) {
          sendJson(res, 400, { error: "Phone number required" });
          return true;
        }
        const removed = store.removeGuest(phone);
        if (removed) {
          await sync.sync();
          sendJson(res, 200, { success: true, message: `Gast ${phone} entfernt.` });
        } else {
          sendJson(res, 404, { error: "Gast nicht gefunden." });
        }
        return true;
      } catch (err) {
        sendJson(res, 500, { error: `Fehler: ${String(err)}` });
        return true;
      }
    }

    return false;
  };
}

/**
 * Simple multipart/form-data parser using busboy.
 */
async function parseMultipartUpload(
  req: IncomingMessage,
): Promise<{ filename: string; fileBuffer: Buffer; category: string }> {
  const Busboy = (await import("busboy")).default;

  return new Promise((resolve, reject) => {
    let filename = "";
    let category = "other";
    const fileChunks: Buffer[] = [];

    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: MAX_UPLOAD_SIZE, files: 1 },
    });

    busboy.on("file", (_fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      filename = info.filename;
      file.on("data", (data: Buffer) => fileChunks.push(data));
    });

    busboy.on("field", (fieldname: string, val: string) => {
      if (fieldname === "category") category = val;
    });

    busboy.on("finish", () => {
      resolve({
        filename,
        fileBuffer: Buffer.concat(fileChunks),
        category,
      });
    });

    busboy.on("error", reject);
    req.pipe(busboy);
  });
}
