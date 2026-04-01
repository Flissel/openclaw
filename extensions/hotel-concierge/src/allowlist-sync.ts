/**
 * Allowlist Config Sync
 *
 * Synchronizes the SQLite allowlist with OpenClaw's WhatsApp config.
 * Writes to openclaw.json via the plugin runtime API to dynamically
 * add/remove phone numbers from the WhatsApp channel allowFrom list.
 */

import type { AllowlistStore } from "./allowlist-store.js";

type ConfigRuntime = {
  loadConfig: () => Promise<Record<string, unknown>>;
  writeConfigFile: (config: Record<string, unknown>, options?: Record<string, unknown>) => Promise<void>;
};

export class AllowlistSync {
  private writing = false;
  private pendingSync = false;

  constructor(
    private readonly store: AllowlistStore,
    private readonly configRuntime: ConfigRuntime,
    private readonly logger: { info: (msg: string) => void; warn: (msg: string) => void },
  ) {}

  /**
   * Sync current active guest numbers to WhatsApp allowFrom config.
   * Uses a simple mutex to prevent concurrent config writes.
   */
  async sync(): Promise<void> {
    if (this.writing) {
      this.pendingSync = true;
      return;
    }

    this.writing = true;
    try {
      await this.doSync();
    } finally {
      this.writing = false;
      if (this.pendingSync) {
        this.pendingSync = false;
        // Process queued sync
        await this.sync();
      }
    }
  }

  private async doSync(): Promise<void> {
    const activeNumbers = this.store.getActivePhoneNumbers();

    const config = await this.configRuntime.loadConfig();
    const channels = (config.channels ?? {}) as Record<string, unknown>;
    const whatsapp = (channels.whatsapp ?? {}) as Record<string, unknown>;

    // Preserve any manually configured numbers (those starting with admin: prefix)
    const existingAllow = (whatsapp.allowFrom ?? []) as string[];
    const manualNumbers = existingAllow.filter((n) => n.startsWith("admin:"));
    const mergedAllowFrom = [...manualNumbers, ...activeNumbers];

    // Update config
    const updatedWhatsapp = {
      ...whatsapp,
      dmPolicy: mergedAllowFrom.length > 0 ? "allowlist" : "pairing",
      allowFrom: mergedAllowFrom.length > 0 ? mergedAllowFrom : undefined,
    };

    const updatedConfig = {
      ...config,
      channels: {
        ...channels,
        whatsapp: updatedWhatsapp,
      },
    };

    await this.configRuntime.writeConfigFile(updatedConfig);
    this.logger.info(
      `hotel-concierge: synced allowlist (${activeNumbers.length} active guests)`,
    );
  }

  /**
   * Remove expired entries and sync the updated list.
   */
  async cleanupAndSync(): Promise<void> {
    const removed = this.store.removeExpired();
    if (removed > 0) {
      this.logger.info(`hotel-concierge: removed ${removed} expired guest(s)`);
    }
    await this.sync();
  }
}
