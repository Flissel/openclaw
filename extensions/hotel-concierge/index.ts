/**
 * OpenClaw Hotel Concierge Plugin
 *
 * WhatsApp-based hotel concierge bot with:
 * - Dynamic guest allowlist with time-based expiry
 * - Qdrant-backed knowledge base (RAG) with local embeddings via Ollama
 * - Admin document upload interface
 * - Dual-workflow: KB-first answers, fallback to clarifying questions
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/hotel-concierge";

import { AllowlistStore } from "./src/allowlist-store.js";
import { AllowlistSync } from "./src/allowlist-sync.js";
import { EmbeddingClient } from "./src/embeddings.js";
import { HotelKnowledgeDB } from "./src/qdrant-client.js";
import { createRegistrationHandler } from "./src/registration-routes.js";
import { createAdminHandler } from "./src/admin-routes.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = join(__dirname, "src", "static");

// ============================================================================
// Config parsing
// ============================================================================

type PluginConfig = {
  qdrantUrl: string;
  qdrantCollection: string;
  ollamaUrl: string;
  embeddingModel: string;
  embeddingDimensions: number;
  hotelId: string;
  maxAccessDays: number;
  ragTopK: number;
  ragMinScore: number;
  language: string;
};

function parseConfig(pluginConfig?: Record<string, unknown>): PluginConfig {
  const c = pluginConfig ?? {};
  return {
    qdrantUrl: String(c.qdrantUrl ?? process.env.QDRANT_URL ?? "http://qdrant:6333"),
    qdrantCollection: String(c.qdrantCollection ?? "hotel_knowledge"),
    ollamaUrl: String(c.ollamaUrl ?? process.env.OLLAMA_BASE_URL ?? "http://ollama:11434"),
    embeddingModel: String(c.embeddingModel ?? "nomic-embed-text"),
    embeddingDimensions: Number(c.embeddingDimensions ?? 768),
    hotelId: String(c.hotelId ?? "wasserburg"),
    maxAccessDays: Number(c.maxAccessDays ?? 4),
    ragTopK: Number(c.ragTopK ?? 5),
    ragMinScore: Number(c.ragMinScore ?? 0.6),
    language: String(c.language ?? "de"),
  };
}

// ============================================================================
// Plugin Definition
// ============================================================================

const hotelConciergePlugin = {
  id: "hotel-concierge",
  name: "Hotel Concierge",
  description: "WhatsApp hotel concierge with dynamic guest access, Qdrant RAG, and admin uploads",

  register(api: OpenClawPluginApi) {
    const cfg = parseConfig(api.pluginConfig);
    const dbPath = api.resolvePath(
      join(process.env.HOTEL_CONCIERGE_DB_PATH ?? "~/.openclaw/hotel-concierge", "allowlist.json"),
    );

    // Initialize components
    const allowlistStore = new AllowlistStore(dbPath);
    const allowlistSync = new AllowlistSync(
      allowlistStore,
      api.runtime.config as {
        loadConfig: () => Promise<Record<string, unknown>>;
        writeConfigFile: (config: Record<string, unknown>) => Promise<void>;
      },
      api.logger,
    );

    const embeddingClient = new EmbeddingClient(
      cfg.embeddingModel,
      cfg.ollamaUrl,
      cfg.embeddingDimensions,
    );

    const knowledgeDB = new HotelKnowledgeDB(
      cfg.qdrantUrl,
      cfg.qdrantCollection,
      cfg.embeddingDimensions,
    );

    api.logger.info(
      `hotel-concierge: registered (hotel: ${cfg.hotelId}, qdrant: ${cfg.qdrantUrl}, ollama: ${cfg.ollamaUrl})`,
    );

    // ========================================================================
    // HTTP Routes - Guest Registration (public)
    // ========================================================================

    const registrationHandler = createRegistrationHandler(
      allowlistStore,
      allowlistSync,
      cfg.maxAccessDays,
      STATIC_DIR,
    );

    api.registerHttpRoute({
      path: "/concierge",
      auth: "plugin",
      match: "prefix",
      handler: async (req, res) => {
        // Only handle registration routes (public)
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const path = url.pathname.replace(/\/+$/, "");

        if (
          path === "/concierge/register" ||
          path === "/concierge/agb"
        ) {
          return registrationHandler(req, res);
        }

        // Admin routes need gateway auth - handled separately
        return false;
      },
    });

    // ========================================================================
    // HTTP Routes - Admin (gateway-protected)
    // ========================================================================

    const adminHandler = createAdminHandler(
      allowlistStore,
      allowlistSync,
      knowledgeDB,
      embeddingClient,
      cfg.hotelId,
      STATIC_DIR,
    );

    api.registerHttpRoute({
      path: "/concierge/admin",
      auth: "gateway",
      match: "prefix",
      handler: adminHandler,
    });

    // ========================================================================
    // Tools - Knowledge Base Search
    // ========================================================================

    api.registerTool(
      {
        name: "hotel_kb_search",
        label: "Hotel Knowledge Base",
        description:
          "Search the hotel knowledge base for information about the hotel, events, local attractions, restaurants, transport, and FAQs. Use this when a guest asks a question.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query in the guest's language" }),
          category: Type.Optional(
            Type.String({
              description: "Filter by category: hotel_info, events, faq, local, dining, transport",
            }),
          ),
        }),
        async execute(_toolCallId, params) {
          const { query, category } = params as { query: string; category?: string };

          try {
            const vector = await embeddingClient.embed(query);
            const results = await knowledgeDB.search(vector, cfg.ragTopK, {
              hotel_id: cfg.hotelId,
              category: category as import("./src/qdrant-client.js").DocumentCategory | undefined,
            });

            if (results.length === 0) {
              return {
                content: [{ type: "text", text: "Keine relevanten Informationen in der Wissensdatenbank gefunden." }],
                details: { count: 0 },
              };
            }

            const text = results
              .map((r, i) => `${i + 1}. [${r.category}] ${r.text} (Quelle: ${r.source_file}, Score: ${(r.score * 100).toFixed(0)}%)`)
              .join("\n\n");

            return {
              content: [{ type: "text", text: `${results.length} Ergebnis(se) gefunden:\n\n${text}` }],
              details: {
                count: results.length,
                results: results.map((r) => ({
                  category: r.category,
                  source: r.source_file,
                  score: r.score,
                  text: r.text.slice(0, 200),
                })),
              },
            };
          } catch (err) {
            return {
              content: [{ type: "text", text: `Fehler bei der Suche: ${String(err)}` }],
              details: { error: String(err) },
            };
          }
        },
      },
      { name: "hotel_kb_search" },
    );

    // ========================================================================
    // Lifecycle Hooks - Auto-RAG
    // ========================================================================

    api.on("before_agent_start", async (event) => {
      if (!event.prompt || event.prompt.length < 3) {
        return;
      }

      try {
        const vector = await embeddingClient.embed(event.prompt);
        const results = await knowledgeDB.search(vector, cfg.ragTopK, {
          hotel_id: cfg.hotelId,
        });

        const goodResults = results.filter((r) => r.score >= cfg.ragMinScore);

        if (goodResults.length > 0) {
          // Primary workflow: inject KB context
          const context = goodResults
            .map((r) => `[${r.category}] ${r.text}`)
            .join("\n---\n");

          api.logger.info?.(
            `hotel-concierge: injecting ${goodResults.length} KB results (best score: ${(goodResults[0].score * 100).toFixed(0)}%)`,
          );

          return {
            prependContext: `<hotel-knowledge-base>\nDie folgenden Informationen stammen aus der Hotel-Wissensdatenbank. Nutze sie um die Frage des Gastes zu beantworten. Antworte auf Deutsch, freundlich und hilfreich.\n${context}\n</hotel-knowledge-base>`,
          };
        } else {
          // Secondary workflow: no good KB match - let the skill handle clarifying questions
          api.logger.info?.("hotel-concierge: no strong KB match, secondary workflow active");
          return {
            prependContext: `<hotel-concierge-mode>no-kb-match</hotel-concierge-mode>`,
          };
        }
      } catch (err) {
        api.logger.warn(`hotel-concierge: auto-RAG failed: ${String(err)}`);
      }
    });

    // ========================================================================
    // Service - Allowlist Expiry Timer
    // ========================================================================

    let expiryInterval: ReturnType<typeof setInterval> | null = null;

    api.registerService({
      id: "hotel-concierge",
      async start() {
        // Initial sync on startup
        await allowlistSync.sync();

        // Check for expired entries every 60 seconds
        expiryInterval = setInterval(async () => {
          try {
            await allowlistSync.cleanupAndSync();
          } catch (err) {
            api.logger.warn(`hotel-concierge: expiry cleanup failed: ${String(err)}`);
          }
        }, 60_000);

        api.logger.info(
          `hotel-concierge: service started (hotel: ${cfg.hotelId}, expiry check: every 60s)`,
        );
      },
      stop() {
        if (expiryInterval) {
          clearInterval(expiryInterval);
          expiryInterval = null;
        }
        allowlistStore.close();
        api.logger.info("hotel-concierge: service stopped");
      },
    });

    // ========================================================================
    // CLI Commands
    // ========================================================================

    api.registerCli(
      ({ program }) => {
        const concierge = program
          .command("concierge")
          .description("Hotel Concierge management commands");

        concierge
          .command("guests")
          .description("List registered guests")
          .action(() => {
            const guests = allowlistStore.getAllGuests();
            const now = Date.now();
            if (guests.length === 0) {
              console.log("No guests registered.");
              return;
            }
            for (const g of guests) {
              const active = g.expires_at > now;
              const expires = new Date(g.expires_at).toLocaleString("de-DE");
              console.log(
                `${active ? "ACTIVE" : "EXPIRED"} ${g.phone_number} (${g.access_days}d, expires: ${expires})`,
              );
            }
          });

        concierge
          .command("add-guest")
          .description("Manually add a guest")
          .argument("<phone>", "Phone number in E.164 format")
          .option("--days <n>", "Access days", "2")
          .action(async (phone, opts) => {
            const entry = allowlistStore.addGuest(phone, parseInt(opts.days));
            await allowlistSync.sync();
            console.log(`Added ${phone} for ${opts.days} day(s). Expires: ${new Date(entry.expires_at).toLocaleString("de-DE")}`);
          });

        concierge
          .command("remove-guest")
          .description("Remove a guest")
          .argument("<phone>", "Phone number")
          .action(async (phone) => {
            const removed = allowlistStore.removeGuest(phone);
            if (removed) {
              await allowlistSync.sync();
              console.log(`Removed ${phone}`);
            } else {
              console.log(`Guest ${phone} not found.`);
            }
          });
      },
      { commands: ["concierge"] },
    );
  },
};

export default hotelConciergePlugin;
