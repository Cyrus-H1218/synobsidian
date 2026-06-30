/**
 * SynObsidian — Cross-device sync plugin for Obsidian.
 *
 * Synchronises your vault between Windows and iPad (or any other device)
 * via S3-compatible cloud storage with AES-256-GCM end-to-end encryption.
 *
 * Supports Cloudflare R2, Backblaze B2, MinIO, AWS S3, and other
 * S3-compatible services.
 */

import { Notice, Plugin, addIcon } from "obsidian";
import {
  type SynObsidianSettings,
  DEFAULT_SETTINGS,
  SynObsidianSettingTab,
  type SyncMode,
  type ISynObsidianPlugin,
  type SyncLogEntry,
} from "./settings";
import { S3Backend, type S3Config } from "./s3Backend";
import { SyncEngine, type Snapshot } from "./syncEngine";
import { deriveKey, generateSalt, decrypt, deriveSaltFromSeed } from "./encrypt";
import { formatTime, sha256 } from "./utils";

// ── Custom ribbon icon (sync arrows) ─────────────────────────────────

addIcon(
  "synobsidian-sync",
  `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="1 4 1 10 7 10"/>
    <polyline points="23 20 23 14 17 14"/>
    <path d="M20.49 9A9 9 0 0 0 5.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 0 1 3.51 15"/>
  </svg>`
);

// ── Plugin data persisted via Obsidian ─────────────────────────────

interface PluginData {
  settings: SynObsidianSettings;
  /** Last successful sync snapshot: path → {hash, mtime, size}. */
  lastSnapshot: Snapshot;
  /** Timestamp of last successful sync. */
  lastSyncTime: number | null;
  /** Last 20 sync log entries (newest first). */
  syncLog: SyncLogEntry[];
}

const DEFAULT_DATA: PluginData = {
  settings: DEFAULT_SETTINGS,
  lastSnapshot: {},
  lastSyncTime: null,
  syncLog: [],
};

// ── Plugin class ────────────────────────────────────────────────────

export default class SynObsidianPlugin extends Plugin implements ISynObsidianPlugin {
  private data: PluginData = DEFAULT_DATA;
  private statusBarEl: HTMLElement | null = null;
  private syncEngine: SyncEngine | null = null;
  private syncRunning = false;
  private autoSyncTimer: number | null = null;

  // ── ISynObsidianPlugin ──────────────────────────────────────────

  getSettings(): SynObsidianSettings {
    return this.data.settings;
  }

  async saveSettings(settings: SynObsidianSettings): Promise<void> {
    this.data.settings = settings;
    await this.saveData(this.data);
    // Restart auto-sync timer with possibly new interval
    this.startAutoSync();
  }

  getSyncLog(): SyncLogEntry[] {
    return this.data.syncLog;
  }

  async testConnection(): Promise<boolean> {
    const backend = this.createBackend();
    if (!backend) {
      throw new Error("请先填写 S3 配置");
    }
    return backend.checkConnectivity();
  }

  async triggerSync(mode: SyncMode): Promise<void> {
    if (this.syncRunning) {
      new Notice("⏳ 同步正在进行中...");
      return;
    }
    await this.runSync(mode);
  }

  // ── Obsidian lifecycle ──────────────────────────────────────────

  async onload(): Promise<void> {
    // Load persisted data
    const loaded = await this.loadData();
    if (loaded) {
      this.data = { ...DEFAULT_DATA, ...loaded };
    }

    // Initialise encryption salt if needed
    await this.ensureEncryptionSalt();

    // Commands
    this.addCommand({
      id: "synobsidian-sync-full",
      name: "全量双向同步",
      callback: () => this.triggerSync("full"),
    });

    this.addCommand({
      id: "synobsidian-sync-push",
      name: "仅推送到云端",
      callback: () => this.triggerSync("push"),
    });

    this.addCommand({
      id: "synobsidian-sync-pull",
      name: "仅从云端拉取",
      callback: () => this.triggerSync("pull"),
    });

    // Ribbon icon
    this.addRibbonIcon("synobsidian-sync", "同步笔记 (SynObsidian)", () =>
      this.triggerSync("full")
    );

    // Status bar
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass("synobsidian-status-bar");
    this.updateStatusBar();

    // Settings tab
    this.addSettingTab(new SynObsidianSettingTab(this.app, this));

    // Auto-sync timer
    this.startAutoSync();
  }

  onunload(): void {
    this.stopAutoSync();
  }

  // ── Sync orchestration ──────────────────────────────────────────

  private async runSync(mode: SyncMode): Promise<void> {
    const settings = this.data.settings;

    // Validate config
    if (!settings.s3Endpoint || !settings.s3Bucket || !settings.s3AccessKeyId) {
      new Notice("⚠ 请先在设置中配置 S3 存储信息");
      return;
    }
    if (settings.enableEncryption && !settings.encryptionPassword) {
      new Notice("⚠ 已启用加密但未设置密码，请在设置中填写加密密码");
      return;
    }

    const backend = this.createBackend();
    if (!backend) {
      new Notice("⚠ S3 配置不完整");
      return;
    }

    // Test connectivity before sync
    this.updateStatusBar("连接中...");
    const connected = await backend.checkConnectivity();
    if (!connected) {
      this.updateStatusBar("连接失败", true);
      new Notice("❌ 无法连接到 S3 存储，请检查配置和网络");
      return;
    }

    this.syncRunning = true;
    this.updateStatusBar("同步中...");

    const engine = new SyncEngine(
      this.app.vault,
      backend,
      settings,
      (msg: string) => this.updateStatusBar(msg)
    );

    try {
      let report;
      switch (mode) {
        case "push":
          report = await engine.pushSync(this.data.lastSnapshot);
          break;
        case "pull":
          report = await engine.pullSync(this.data.lastSnapshot);
          break;
        case "full":
        default:
          report = await engine.fullSync(this.data.lastSnapshot);
          break;
      }

      const { report: syncReport, newSnapshot } = report;

      // Save new snapshot
      this.data.lastSnapshot = newSnapshot;
      this.data.lastSyncTime = Date.now();

      // Append to sync log (keep last 20 entries)
      const logEntry: SyncLogEntry = {
        timestamp: Date.now(),
        mode,
        uploaded: syncReport.uploaded,
        downloaded: syncReport.downloaded,
        remoteDeleted: syncReport.remoteDeleted,
        localDeleted: syncReport.localDeleted,
        conflicts: syncReport.conflicts,
        errors: syncReport.errors,
        durationMs: syncReport.durationMs,
      };
      this.data.syncLog.unshift(logEntry);
      if (this.data.syncLog.length > 20) {
        this.data.syncLog = this.data.syncLog.slice(0, 20);
      }
      await this.saveData(this.data);

      // Build summary
      const parts: string[] = [];
      if (syncReport.uploaded > 0) parts.push(`↑${syncReport.uploaded}`);
      if (syncReport.downloaded > 0) parts.push(`↓${syncReport.downloaded}`);
      if (syncReport.conflicts > 0) parts.push(`⚡${syncReport.conflicts}`);
      if (syncReport.errors.length > 0) parts.push(`⚠${syncReport.errors.length}`);

      if (parts.length === 0 && syncReport.remoteDeleted === 0 && syncReport.localDeleted === 0) {
        new Notice("✓ 所有文件已是最新");
      } else if (syncReport.errors.length > 0) {
        // Show first error detail in the Notice so the user knows what went wrong
        const firstErr = syncReport.errors[0];
        const more = syncReport.errors.length > 1
          ? ` (+${syncReport.errors.length - 1} 个)`
          : "";
        new Notice(
          `同步完成: ${parts.join(" ")} | ${firstErr}${more}`,
          10000
        );
        console.warn("[SynObsidian]", syncReport.errors);
      } else {
        new Notice(`同步完成: ${parts.join(" ")}`, 4000);
      }

      this.updateStatusBar("就绪");
    } catch (e: any) {
      new Notice(`❌ 同步失败: ${e.message}`, 8000);
      console.error("[SynObsidian] Sync error:", e);
      this.updateStatusBar("同步出错", true);
    } finally {
      this.syncRunning = false;
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Create an S3Backend from current settings. Returns null if config is incomplete. */
  private createBackend(): S3Backend | null {
    const s = this.data.settings;
    if (!s.s3Endpoint || !s.s3Bucket || !s.s3AccessKeyId || !s.s3SecretAccessKey) {
      return null;
    }
    const config: S3Config = {
      endpoint: s.s3Endpoint,
      region: s.s3Region || "auto",
      bucket: s.s3Bucket,
      accessKeyId: s.s3AccessKeyId,
      secretAccessKey: s.s3SecretAccessKey,
      pathPrefix: s.s3PathPrefix || undefined,
      forcePathStyle: s.s3ForcePathStyle,
    };
    return new S3Backend(config);
  }

  /** Initialise the encryption salt on first use. */
  private async ensureEncryptionSalt(): Promise<void> {
    const settings = this.data.settings;
    if (settings.enableEncryption && settings.encryptionPassword && !settings.encryptionSaltHex) {
      // Derive salt from vault name — this ensures the same salt on all
      // devices with the same vault name, so the same password works everywhere.
      const seed = this.app.vault.getName() + ":synobsidian:salt";
      const salt = await deriveSaltFromSeed(seed);
      settings.encryptionSaltHex = Array.from(salt)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      await this.saveSettings(settings);
    }
  }

  /** Update the status bar element. */
  private updateStatusBar(msg?: string, isError?: boolean): void {
    if (!this.statusBarEl) return;

    this.statusBarEl.removeClass("syncing", "success", "error");

    if (msg) {
      this.statusBarEl.setText(`🔄 ${msg}`);
      if (isError) {
        this.statusBarEl.addClass("error");
      } else {
        this.statusBarEl.addClass("syncing");
      }
    } else {
      // Show last sync time
      const last = this.data.lastSyncTime;
      if (last) {
        this.statusBarEl.setText(`📋 上次同步: ${formatTime(new Date(last))}`);
        this.statusBarEl.addClass("success");
      } else {
        this.statusBarEl.setText("📋 点击同步 (SynObsidian)");
      }
    }
  }

  /** Start (or restart) the periodic auto-sync timer. */
  private startAutoSync(): void {
    this.stopAutoSync();

    const intervalMin = this.data.settings.autoSyncInterval;
    if (!intervalMin || intervalMin <= 0) return;

    const intervalMs = intervalMin * 60 * 1000;
    this.autoSyncTimer = window.setInterval(() => {
      // Only trigger if sync is not already running and config is valid
      if (this.syncRunning) return;

      const s = this.data.settings;
      if (!s.s3Endpoint || !s.s3Bucket || !s.s3AccessKeyId) return;
      if (s.enableEncryption && !s.encryptionPassword) return;

      this.triggerSync("full");
    }, intervalMs);

    // Register the timer so Obsidian cleans it up on plugin unload
    this.registerInterval(this.autoSyncTimer);
  }

  /** Stop the auto-sync timer. */
  private stopAutoSync(): void {
    if (this.autoSyncTimer !== null) {
      window.clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }
}
