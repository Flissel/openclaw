/**
 * Guest Registration HTTP Routes
 *
 * Public routes (auth: "plugin") for guest self-registration.
 * Serves the registration form and handles phone number submission.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AllowlistStore } from "./allowlist-store.js";
import type { AllowlistSync } from "./allowlist-sync.js";

// E.164 phone number validation
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

function parseBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function createRegistrationHandler(
  store: AllowlistStore,
  sync: AllowlistSync,
  maxAccessDays: number,
  staticDir: string,
) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const path = url.pathname.replace(/\/+$/, "");

    // GET /concierge/register -> serve registration page
    if (req.method === "GET" && path === "/concierge/register") {
      const html = readFileSync(join(staticDir, "register.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    // GET /concierge/agb -> serve terms page
    if (req.method === "GET" && path === "/concierge/agb") {
      const html = readFileSync(join(staticDir, "agb.html"), "utf-8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return true;
    }

    // POST /concierge/register -> handle registration
    if (req.method === "POST" && path === "/concierge/register") {
      try {
        const body = await parseBody(req);
        const contentType = req.headers["content-type"] ?? "";
        let phoneNumber: string;
        let accessDays: number;
        let agbAccepted: boolean;

        if (contentType.includes("application/json")) {
          const data = JSON.parse(body);
          phoneNumber = String(data.phone_number ?? "").trim();
          accessDays = parseInt(String(data.access_days ?? "1"), 10);
          agbAccepted = Boolean(data.agb_accepted);
        } else {
          // application/x-www-form-urlencoded
          const params = new URLSearchParams(body);
          phoneNumber = (params.get("phone_number") ?? "").trim();
          accessDays = parseInt(params.get("access_days") ?? "1", 10);
          agbAccepted = params.get("agb_accepted") === "on" || params.get("agb_accepted") === "true";
        }

        // Validate
        if (!agbAccepted) {
          sendJson(res, 400, { error: "Sie müssen die AGB akzeptieren." });
          return true;
        }

        if (!E164_REGEX.test(phoneNumber)) {
          sendJson(res, 400, {
            error: "Ungültige Telefonnummer. Bitte im internationalen Format eingeben (z.B. +491234567890).",
          });
          return true;
        }

        if (isNaN(accessDays) || accessDays < 1 || accessDays > maxAccessDays) {
          sendJson(res, 400, {
            error: `Zugang muss zwischen 1 und ${maxAccessDays} Tagen liegen.`,
          });
          return true;
        }

        // Register guest
        const entry = store.addGuest(phoneNumber, accessDays);
        await sync.sync();

        sendJson(res, 200, {
          success: true,
          message: `Willkommen! Ihre Nummer ${phoneNumber} ist für ${accessDays} Tag(e) freigeschaltet. Sie können uns jetzt per WhatsApp kontaktieren.`,
          expires_at: new Date(entry.expires_at).toISOString(),
        });
        return true;
      } catch (err) {
        sendJson(res, 500, { error: "Registrierung fehlgeschlagen. Bitte versuchen Sie es erneut." });
        return true;
      }
    }

    return false;
  };
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
