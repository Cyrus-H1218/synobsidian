/**
 * Core sync engine.
 *
 * Implements bidirectional hash-based differential sync between the local
 * Obsidian vault and an S3-compatible remote backend.
 *
 * Algorithm overview:
 *  1. Build local index (SHA-256 hashes of every synced file)
 *  2. Fetch remote index (S3 object listing with metadata)
 *  3. Compare with last successful snapshot
 *  4. Classify each file: upload, download, skip, or conflict
 *  5. Execute the plan with safety guards
 *  6. Save the new snapshot
 */

import type { Vault, TFile, TFolder } from "obsidian";
import type { S3Backend, RemoteFileEntry } from "./s3Backend";
import type { Snapshot, FileEntry } from "./fileIndex";
import { buildLocalIndex, diffSnapshots, buildRemoteLookup } from "./fileIndex";
import { encrypt, decrypt, deriveKey, generateSalt, isEncrypted } from "./encrypt";
import { sha256, conflictTimestamp, isExcluded } from "./utils";
import type { SynObsidianSettings } from "./settings";

// Re-export types
export type { FileEntry, Snapshot };

/** Type guard: check if an abstract file is a folder. */
function isFolder(file: any): file is TFolder {
  return file && "children" in file;
}

// ── Types ────────────────────────────────────────────────────────────

export interface SyncPlan {
  /** Files to upload (local → remote). */
  uploads: string[];
  /** Files to download (remote → local). */
  downloads: string[];
  /** Files to delete from remote (deleted locally). */
  remoteDeletes: string[];
  /** Files to delete locally (deleted remotely). */
  localDeletes: string[];
  /** Files in conflict — both sides changed since last sync. */
  conflicts: ConflictEntry[];
  /** Files skipped (no changes). */
  skipped: number;
  /** Total files to process (excluding skipped). */
  totalOps: number;
}

export interface ConflictEntry {
  path: string;
  localMtime: number;
  remoteMtime: number;
  localHash: string;
  remoteEtag: string;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  remoteDeleted: number;
  localDeleted: number;
  conflicts: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

// ── Sync engine class ────────────────────────────────────────────────

export class SyncEngine {
  private vault: Vault;
  private backend: S3Backend;
  private settings: SynObsidianSettings;
  /** Callback to update status bar text. */
  private onProgress?: (msg: string) => void;
  /** Flag to allow cancellation. */
  private cancelled = false;

  constructor(
    vault: Vault,
    backend: S3Backend,
    settings: SynObsidianSettings,
    onProgress?: (msg: string) => void
  ) {
    this.vault = vault;
    this.backend = backend;
    this.settings = settings;
    this.onProgress = onProgress;
  }

  /** Cancel an in-progress sync. */
  cancel(): void {
    this.cancelled = true;
  }

  // ── Main sync entry points ──────────────────────────────────────

  /**
   * Full bidirectional sync.
   * Uploads local changes, downloads remote changes, resolves conflicts.
   */
  async fullSync(
    lastSnapshot: Snapshot | null
  ): Promise<{ report: SyncReport; newSnapshot: Snapshot }> {
    return this.runSync(lastSnapshot, "full");
  }

  /**
   * Push-only sync: upload local changes, ignore remote changes.
   */
  async pushSync(
    lastSnapshot: Snapshot | null
  ): Promise<{ report: SyncReport; newSnapshot: Snapshot }> {
    return this.runSync(lastSnapshot, "push");
  }

  /**
   * Pull-only sync: download remote changes, ignore local changes.
   */
  async pullSync(
    lastSnapshot: Snapshot | null
  ): Promise<{ report: SyncReport; newSnapshot: Snapshot }> {
    return this.runSync(lastSnapshot, "pull");
  }

  // ── Core sync logic ──────────────────────────────────────────────

  private async runSync(
    lastSnapshot: Snapshot | null,
    mode: "full" | "push" | "pull"
  ): Promise<{ report: SyncReport; newSnapshot: Snapshot }> {
    const startTime = Date.now();
    const report: SyncReport = {
      uploaded: 0,
      downloaded: 0,
      remoteDeleted: 0,
      localDeleted: 0,
      conflicts: 0,
      skipped: 0,
      errors: [],
      durationMs: 0,
    };

    this.cancelled = false;
    this.setProgress("正在分析文件变化...");

    // 1. Build local index
    const excludePatterns = this.settings.excludePatterns
      .split("\n")
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const localSnapshot = await buildLocalIndex(this.vault, excludePatterns);

    // 2. Fetch remote index
    let remoteEntries: RemoteFileEntry[] = [];
    try {
      remoteEntries = await this.backend.listAllFiles();
    } catch (e: any) {
      report.errors.push(`无法获取远程文件列表: ${e.message}`);
      report.durationMs = Date.now() - startTime;
      return { report, newSnapshot: lastSnapshot ?? {} };
    }
    const remoteLookup = buildRemoteLookup(remoteEntries);

    // 3. Diff local vs last snapshot
    const prevSnapshot = lastSnapshot ?? {};
    const localDiff = diffSnapshots(localSnapshot, prevSnapshot);

    // 4. Diff remote vs last snapshot
    const remoteDiff = this.diffRemote(remoteLookup, prevSnapshot);

    // 5. Build sync plan
    const plan = this.buildPlan(
      localSnapshot,
      remoteLookup,
      localDiff,
      remoteDiff,
      prevSnapshot,
      mode
    );

    // 6. Safety check
    if (plan.totalOps > 50) {
      const ratio = plan.totalOps / Math.max(Object.keys(prevSnapshot).length, 1);
      if (ratio > 0.5 && Object.keys(prevSnapshot).length > 10) {
        report.errors.push(
          `安全保护：本次同步将修改 ${plan.totalOps} 个文件（超过总数的 50%）。` +
            `若确实需要，请手动运行一次"下拉同步"或"上推同步"。`
        );
        report.durationMs = Date.now() - startTime;
        return { report, newSnapshot: localSnapshot };
      }
    }
    // Separate check for first sync (no previous snapshot) — don't block
    if (plan.totalOps === 0) {
      this.setProgress("所有文件已是最新 ✓");
      report.durationMs = Date.now() - startTime;
      return { report, newSnapshot: localSnapshot };
    }

    // 7. Execute plan
    this.setProgress(`同步中... 0/${plan.totalOps}`);
    let completed = 0;

    // -- Downloads (must happen before uploads to get remote changes first) --
    for (const path of plan.downloads) {
      if (this.cancelled) {
        report.errors.push("同步已取消");
        break;
      }
      try {
        const result = await this.backend.downloadFile(path);
        if (!result) {
          report.errors.push(`下载失败(文件不存在): ${path}`);
          completed++;
          continue;
        }

        let content: string;
        if (result.encrypted || isEncrypted(result.content)) {
          if (!this.settings.encryptionPassword) {
            report.errors.push(`无法解密 ${path}：未设置加密密码`);
            completed++;
            continue;
          }
          const decrypted = await decrypt(result.content, this.settings.encryptionPassword);
          if (decrypted === null) {
            report.errors.push(`解密失败 ${path}：密码错误或数据损坏`);
            completed++;
            continue;
          }
          content = decrypted;
        } else {
          const dec = new TextDecoder();
          content = dec.decode(result.content);
        }

        await this.writeLocalFile(path, content, result.mtime);
        report.downloaded++;
      } catch (e: any) {
        report.errors.push(`下载 ${path}: ${e.message}`);
      }
      completed++;
      this.setProgress(`同步中... ${completed}/${plan.totalOps}`);
    }

    // -- Local deletes --
    for (const path of plan.localDeletes) {
      if (this.cancelled) break;
      try {
        await this.deleteLocalFile(path);
        report.localDeleted++;
      } catch (e: any) {
        report.errors.push(`本地删除 ${path}: ${e.message}`);
      }
      completed++;
      this.setProgress(`同步中... ${completed}/${plan.totalOps}`);
    }

    // -- Uploads --
    for (const path of plan.uploads) {
      if (this.cancelled) break;
      try {
        const content = await this.readLocalFile(path);
        if (content === null) {
          report.errors.push(`上传失败(无法读取): ${path}`);
          completed++;
          continue;
        }

        const localEntry = localSnapshot[path];
        let body: Uint8Array;
        let encrypted = false;

        if (this.settings.enableEncryption && this.settings.encryptionPassword) {
          const saltHex = this.settings.encryptionSaltHex;
          if (!saltHex) {
            report.errors.push(`无法加密 ${path}：加密 salt 未初始化`);
            completed++;
            continue;
          }
          const salt = new Uint8Array(
            saltHex.match(/.{1,2}/g)!.map((b) => parseInt(b, 16))
          );
          const key = await deriveKey(this.settings.encryptionPassword, salt);
          const encBuf = await encrypt(content, key, salt);
          body = new Uint8Array(encBuf);
          encrypted = true;
        } else {
          const enc = new TextEncoder();
          body = enc.encode(content);
        }

        await this.backend.uploadFile(
          path,
          body,
          localEntry?.mtime ?? Date.now(),
          encrypted
        );
        report.uploaded++;
      } catch (e: any) {
        report.errors.push(`上传 ${path}: ${e.message}`);
      }
      completed++;
      this.setProgress(`同步中... ${completed}/${plan.totalOps}`);
    }

    // -- Remote deletes --
    for (const path of plan.remoteDeletes) {
      if (this.cancelled) break;
      try {
        await this.backend.deleteFile(path);
        report.remoteDeleted++;
      } catch (e: any) {
        report.errors.push(`远程删除 ${path}: ${e.message}`);
      }
      completed++;
      this.setProgress(`同步中... ${completed}/${plan.totalOps}`);
    }

    // -- Conflicts --
    for (const conflict of plan.conflicts) {
      if (this.cancelled) break;
      try {
        await this.resolveConflict(conflict, localSnapshot);
        report.conflicts++;
      } catch (e: any) {
        report.errors.push(`冲突处理 ${conflict.path}: ${e.message}`);
      }
      completed++;
      this.setProgress(`同步中... ${completed}/${plan.totalOps}`);
    }

    report.durationMs = Date.now() - startTime;

    // 8. Build new snapshot (post-sync state)
    const newSnapshot = await buildLocalIndex(this.vault, excludePatterns);

    return { report, newSnapshot };
  }

  // ── Plan builder ─────────────────────────────────────────────────

  private buildPlan(
    localSnapshot: Snapshot,
    remoteLookup: Map<string, RemoteFileEntry>,
    localDiff: import("./fileIndex").IndexDiff,
    remoteDiff: ReturnType<SyncEngine["diffRemote"]>,
    prevSnapshot: Snapshot,
    mode: "full" | "push" | "pull"
  ): SyncPlan {
    const plan: SyncPlan = {
      uploads: [],
      downloads: [],
      remoteDeletes: [],
      localDeletes: [],
      conflicts: [],
      skipped: 0,
      totalOps: 0,
    };

    // Collect all paths
    const allPaths = new Set<string>([
      ...Object.keys(localSnapshot),
      ...remoteLookup.keys(),
    ]);

    for (const path of allPaths) {
      const local = localSnapshot[path];
      const remote = remoteLookup.get(path);

      if (local && !remote) {
        // Local exists, remote missing → upload (if push or full)
        if (mode !== "pull") {
          plan.uploads.push(path);
        }
      } else if (!local && remote) {
        // Remote exists, local missing → download (if pull or full)
        if (mode !== "push") {
          plan.downloads.push(path);
        }
      } else if (local && remote) {
        // Both exist — check for changes
        const prev = prevSnapshot[path];
        const localChanged = !prev || prev.hash !== local.hash;
        const remoteChanged = this.remoteChanged(remote, prev);

        if (!localChanged && !remoteChanged) {
          // Neither changed — skip
          plan.skipped++;
        } else if (localChanged && !remoteChanged) {
          // Only local changed → upload
          if (mode !== "pull") plan.uploads.push(path);
        } else if (!localChanged && remoteChanged) {
          // Only remote changed → download
          if (mode !== "push") plan.downloads.push(path);
        } else {
          // Both changed → conflict
          plan.conflicts.push({
            path,
            localMtime: local.mtime,
            remoteMtime: remote.mtime,
            localHash: local.hash,
            remoteEtag: remote.etag,
          });
        }
      }
    }

    // Handle deletions (from diff)
    if (mode !== "pull") {
      for (const path of localDiff.deleted) {
        if (prevSnapshot[path] && remoteLookup.has(path)) {
          plan.remoteDeletes.push(path);
        }
      }
    }

    if (mode !== "push") {
      for (const path of remoteDiff.deleted) {
        if (prevSnapshot[path] && localSnapshot[path]) {
          plan.localDeletes.push(path);
        }
      }
    }

    plan.totalOps =
      plan.uploads.length +
      plan.downloads.length +
      plan.remoteDeletes.length +
      plan.localDeletes.length +
      plan.conflicts.length;

    return plan;
  }

  // ── Helpers ──────────────────────────────────────────────────────

  /** Diff remote entries against the last snapshot. */
  private diffRemote(
    remoteLookup: Map<string, RemoteFileEntry>,
    prevSnapshot: Snapshot
  ): { added: string[]; modified: string[]; deleted: string[] } {
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [path, remote] of remoteLookup) {
      const prev = prevSnapshot[path];
      if (!prev) {
        added.push(path);
      } else if (remote.mtime > prev.mtime) {
        // Remote is newer → consider modified
        modified.push(path);
      }
    }

    for (const path of Object.keys(prevSnapshot)) {
      if (!remoteLookup.has(path)) {
        deleted.push(path);
      }
    }

    return { added, modified, deleted };
  }

  /** Check if a remote entry changed since the snapshot was taken. */
  private remoteChanged(
    remote: RemoteFileEntry,
    prev: import("./fileIndex").FileEntry | undefined
  ): boolean {
    if (!prev) return true;
    // Compare by mtime — ETag can change without content change for some providers
    // But we use mtime which we set explicitly on upload
    return remote.mtime > prev.mtime;
  }

  /** Resolve a single conflict. */
  private async resolveConflict(
    conflict: ConflictEntry,
    localSnapshot: Snapshot
  ): Promise<void> {
    const strategy = this.settings.conflictStrategy;

    if (strategy === "newer") {
      if (conflict.localMtime >= conflict.remoteMtime) {
        // Local is newer — upload to overwrite remote
        const content = await this.readLocalFile(conflict.path);
        if (content) {
          const entry = localSnapshot[conflict.path];
          await this.backend.uploadFile(
            conflict.path,
            new TextEncoder().encode(content),
            entry?.mtime ?? Date.now(),
            this.settings.enableEncryption
          );
        }
      } else {
        // Remote is newer — download to overwrite local
        // Back up the local version first
        await this.backupLocalFile(conflict.path);
        // The download will happen in the main loop — this just triggers backup
      }
    } else {
      // Manual — always create a conflict backup
      await this.backupLocalFile(conflict.path);
    }
  }

  /** Read a local file as a string. */
  private async readLocalFile(path: string): Promise<string | null> {
    try {
      const file = this.vault.getAbstractFileByPath(path);
      if (!file || isFolder(file)) return null;
      return await this.vault.read(file as TFile);
    } catch {
      return null;
    }
  }

  /** Write content to a local file, creating parent folders if needed. */
  private async writeLocalFile(
    path: string,
    content: string,
    mtime?: number
  ): Promise<void> {
    // Ensure parent folders exist
    const dirPath = path.split("/").slice(0, -1).join("/");
    if (dirPath) {
      const dir = this.vault.getAbstractFileByPath(dirPath);
      if (!dir) {
        await this.vault.createFolder(dirPath);
      }
    }

    const file = this.vault.getAbstractFileByPath(path);
    if (file && !isFolder(file)) {
      await this.vault.modify(file as TFile, content);
    } else if (!file) {
      await this.vault.create(path, content);
    }
  }

  /** Delete a local file, backing it up first. */
  private async deleteLocalFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file || isFolder(file)) return;

    // Move to _trash/ first (safety)
    const trashPath = `_trash/${path}.deleted-${conflictTimestamp()}`;
    try {
      const trashDir = trashPath.split("/").slice(0, -1).join("/");
      if (trashDir) {
        const dir = this.vault.getAbstractFileByPath(trashDir);
        if (!dir) await this.vault.createFolder(trashDir);
      }
      // Read content, create backup, then delete
      const content = await this.vault.read(file as TFile);
      await this.vault.create(trashPath, content);
    } catch {
      // If backup fails, still try to delete
    }

    await this.vault.delete(file as TFile);
  }

  /** Back up a local file before overwriting during conflict resolution. */
  private async backupLocalFile(path: string): Promise<void> {
    const file = this.vault.getAbstractFileByPath(path);
    if (!file || isFolder(file)) return;

    const ts = conflictTimestamp();
    const ext = path.includes(".") ? path.split(".").pop() : "md";
    const base = path.replace(/\.[^.]+$/, "");
    const backupPath = `${base}.conflict-${ts}.${ext}`;

    try {
      const content = await this.vault.read(file as TFile);
      await this.vault.create(backupPath, content);
    } catch {
      // Non-fatal
    }
  }

  /** Update the progress indicator. */
  private setProgress(msg: string): void {
    if (this.onProgress) {
      this.onProgress(msg);
    }
  }
}
