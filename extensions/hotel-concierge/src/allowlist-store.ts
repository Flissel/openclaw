/**
 * Dynamic WhatsApp Allowlist Store
 *
 * JSON-file-based storage for guest phone numbers with time-based expiry.
 * Uses a simple JSON file persisted to disk - sufficient for hotel-scale
 * guest lists (typically < 100 concurrent entries).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type GuestEntry = {
  id: string;
  phone_number: string;
  expires_at: number;
  registered_at: number;
  agb_accepted: number;
  access_days: number;
};

type StoreData = {
  guests: GuestEntry[];
};

export class AllowlistStore {
  private data: StoreData;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    this.data = this.load();
  }

  private load(): StoreData {
    if (existsSync(this.filePath)) {
      try {
        const raw = readFileSync(this.filePath, "utf-8");
        return JSON.parse(raw) as StoreData;
      } catch {
        return { guests: [] };
      }
    }
    return { guests: [] };
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), "utf-8");
  }

  addGuest(phoneNumber: string, accessDays: number): GuestEntry {
    const now = Date.now();
    const expiresAt = now + accessDays * 24 * 60 * 60 * 1000;
    const id = randomUUID();

    // Remove existing entry for this number (upsert behavior)
    this.data.guests = this.data.guests.filter((g) => g.phone_number !== phoneNumber);

    const entry: GuestEntry = {
      id,
      phone_number: phoneNumber,
      expires_at: expiresAt,
      registered_at: now,
      agb_accepted: 1,
      access_days: accessDays,
    };

    this.data.guests.push(entry);
    this.save();
    return entry;
  }

  removeGuest(phoneNumber: string): boolean {
    const before = this.data.guests.length;
    this.data.guests = this.data.guests.filter((g) => g.phone_number !== phoneNumber);
    if (this.data.guests.length < before) {
      this.save();
      return true;
    }
    return false;
  }

  getActiveGuests(): GuestEntry[] {
    const now = Date.now();
    return this.data.guests.filter((g) => g.expires_at > now);
  }

  getAllGuests(): GuestEntry[] {
    return [...this.data.guests].sort((a, b) => b.registered_at - a.registered_at);
  }

  removeExpired(): number {
    const now = Date.now();
    const before = this.data.guests.length;
    this.data.guests = this.data.guests.filter((g) => g.expires_at > now);
    const removed = before - this.data.guests.length;
    if (removed > 0) {
      this.save();
    }
    return removed;
  }

  getActivePhoneNumbers(): string[] {
    return this.getActiveGuests().map((g) => g.phone_number);
  }

  close(): void {
    // No-op for JSON store
  }
}
