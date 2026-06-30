/**
 * Local file index — builds a snapshot of all markdown (and attachment) files
 * in the vault and compares it with a previously stored snapshot to detect
 * additions, modifications, and deletions.
 *
 * We hash file contents with SHA-256, so even a single character change is
 * detected regardless of filesystem mtime precision.
 */

import type { Vault, TFile } from "obsidian";
import { sha256, isExcluded } from "./utils";

// ── Types ────────────────────────────────────────────────────────────

export interface FileEntry {
  path: string;
  hash: string;
  mtime: number;
  size: number;
}

/** A snapshot of the entire vault at a point in time. */
export type Snapshot = Record<string, FileEntry>;

/** The result of diffing the current index against the last snapshot. */
export interface IndexDiff {
  /** Files that exist locally but not in the snapshot (new). */
  added: FileEntry[];
  /** Files whose hash differs from the snapshot (modified). */
  modified: FileEntry[];
  /** Files that were in the snapshot but no longer exist locally (deleted). */
  deleted: string[];
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Recursively walk the vault and build a map of path → FileEntry.
 *
 * Uses `vault.getFiles()` for efficient traversal (avoids manually
 * walking directory trees).
 */
export async function buildLocalIndex(
  vault: Vault,
  excludePatterns: string[] = []
): Promise<Snapshot> {
  const snapshot: Snapshot = {};
  const files = vault.getFiles();

  for (const file of files) {
    // Only sync files within the vault — skip plugin internals
    if (
      file.path.startsWith(".obsidian/") ||
      file.path.startsWith(".trash/") ||
      file.path.startsWith("_trash/")
    ) {
      continue;
    }

    if (isExcluded(file.path, excludePatterns)) {
      continue;
    }

    try {
      // Read as binary string to avoid encoding issues
      const content = await vault.read(file);
      const hash = await sha256(content);

      snapshot[file.path] = {
        path: file.path,
        hash,
        mtime: file.stat.mtime,
        size: file.stat.size,
      };
    } catch {
      // Skip files we can't read (e.g. large binaries)
      continue;
    }
  }

  return snapshot;
}

/**
 * Diff the current snapshot against a previous snapshot.
 *
 * - added:   in current, not in previous
 * - modified: in both, but hash changed
 * - deleted:  in previous, not in current
 */
export function diffSnapshots(
  current: Snapshot,
  previous: Snapshot
): IndexDiff {
  const added: FileEntry[] = [];
  const modified: FileEntry[] = [];
  const deleted: string[] = [];

  // Find added and modified
  for (const [path, entry] of Object.entries(current)) {
    const prev = previous[path];
    if (!prev) {
      added.push(entry);
    } else if (prev.hash !== entry.hash) {
      modified.push(entry);
    }
  }

  // Find deleted
  for (const path of Object.keys(previous)) {
    if (!current[path]) {
      deleted.push(path);
    }
  }

  return { added, modified, deleted };
}

/**
 * Build a lookup key → RemoteFileEntry for efficient comparison.
 */
export function buildRemoteLookup(
  remote: import("./s3Backend").RemoteFileEntry[]
): Map<string, import("./s3Backend").RemoteFileEntry> {
  const map = new Map<string, import("./s3Backend").RemoteFileEntry>();
  for (const entry of remote) {
    map.set(entry.path, entry);
  }
  return map;
}
