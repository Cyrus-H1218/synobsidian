/**
 * S3-compatible storage backend.
 *
 * Uses @aws-sdk/client-s3 v3, which works in both Electron (Windows) and
 * mobile WebView (iPad Obsidian) via the fetch API.
 *
 * Callers must configure CORS on the S3 bucket to allow requests from
 * obsidian:// origins (desktop) and app:// origins (mobile).
 *
 * File metadata (mtime, original path) is stored as S3 object custom metadata.
 */

import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";

// The AWS SDK v3 type _Object may not expose Metadata in all versions.
// We use a local type that includes the fields we need from real S3 API responses.
interface S3ObjectWithMeta {
  Key?: string;
  Size?: number;
  ETag?: string;
  LastModified?: Date;
  Metadata?: Record<string, string>;
}

// Helper to cast _Object to our local type
function asObj(o: any): S3ObjectWithMeta {
  return o as S3ObjectWithMeta;
}

// ── Types ─────────────────────────────────────────────────────────────

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  pathPrefix?: string;
  /** If true, use path-style addressing (required for R2, MinIO). */
  forcePathStyle?: boolean;
}

export interface RemoteFileEntry {
  /** Full S3 object key. */
  key: string;
  /** File path within the vault (stripped of prefix). */
  path: string;
  /** Modification time from metadata, or last-modified. */
  mtime: number;
  /** File size in bytes. */
  size: number;
  /** S3 ETag (used for change detection). */
  etag: string;
  /** Whether the file is encrypted. */
  encrypted: boolean;
}

// ── Metadata helpers ──────────────────────────────────────────────────

const META_MTIME = "mtime";
const META_ENCRYPTED = "encrypted";
const META_ORIG_PATH = "orig-path";

function toMetaValue(num: number): string {
  return num.toString();
}

function fromMetaValue(s: string | undefined, fallback: number): number {
  if (!s) return fallback;
  const n = parseInt(s, 10);
  return Number.isNaN(n) ? fallback : n;
}

// Ensure metadata keys pass S3 validation (lowercase, no underscores)
function cleanMetaKey(key: string): string {
  return key.toLowerCase().replace(/_/g, "-");
}

// ── Backend class ─────────────────────────────────────────────────────

export class S3Backend {
  private client: S3Client;
  private config: S3Config;

  constructor(config: S3Config) {
    this.config = config;

    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.forcePathStyle ?? true,
      // On mobile, we need the fetch handler; the SDK detects the environment
      // automatically, but setting a custom requestHandler is unnecessary.
    });
  }

  /** Normalise a vault path into an S3 object key. */
  private toKey(vaultPath: string): string {
    const prefix = this.config.pathPrefix
      ? this.config.pathPrefix.replace(/\/+$/, "") + "/"
      : "";
    return prefix + vaultPath.replace(/\\/g, "/");
  }

  /** Strip the path prefix from an S3 key to recover the vault path. */
  private fromKey(key: string): string {
    const prefix = this.config.pathPrefix
      ? this.config.pathPrefix.replace(/\/+$/, "") + "/"
      : "";
    if (prefix && key.startsWith(prefix)) {
      return key.slice(prefix.length);
    }
    return key;
  }

  // ── Public API ─────────────────────────────────────────────────────

  /** Verify connectivity by checking if the bucket exists and is reachable. */
  async checkConnectivity(): Promise<boolean> {
    try {
      await this.client.send(
        new HeadBucketCommand({ Bucket: this.config.bucket })
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * List all objects in the bucket under the configured prefix.
   * Handles pagination automatically (up to 10,000 objects).
   */
  async listAllFiles(): Promise<RemoteFileEntry[]> {
    const results: RemoteFileEntry[] = [];
    const prefix = this.config.pathPrefix
      ? this.config.pathPrefix.replace(/\/+$/, "") + "/"
      : "";

    let continuationToken: string | undefined;

    do {
      const cmd = new ListObjectsV2Command({
        Bucket: this.config.bucket,
        Prefix: prefix || undefined,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      });

      const resp = await this.client.send(cmd);
      const contents = resp.Contents ?? [];

      for (const o of contents) {
        const obj = asObj(o);
        if (!obj.Key) continue;
        // Skip "folder" markers (keys ending with /)
        if (obj.Key.endsWith("/")) continue;

        const vaultPath = this.fromKey(obj.Key);
        // Skip files outside the prefix (shouldn't happen with Prefix param, but safe)
        if (!vaultPath) continue;

        const mtimeMeta = obj.Metadata
          ? obj.Metadata[cleanMetaKey(META_MTIME)]
          : undefined;
        const encryptedMeta = obj.Metadata
          ? obj.Metadata[cleanMetaKey(META_ENCRYPTED)]
          : undefined;

        results.push({
          key: obj.Key,
          path: vaultPath,
          mtime: fromMetaValue(
            mtimeMeta,
            obj.LastModified ? obj.LastModified.getTime() : 0
          ),
          size: obj.Size ?? 0,
          etag: obj.ETag ?? "",
          encrypted: encryptedMeta === "true",
        });
      }

      continuationToken = resp.NextContinuationToken;
    } while (continuationToken);

    return results;
  }

  /** Upload file content to S3 with metadata. */
  async uploadFile(
    vaultPath: string,
    content: Uint8Array,
    mtime: number,
    encrypted: boolean
  ): Promise<string> {
    const key = this.toKey(vaultPath);
    const cmd = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      Body: content,
      Metadata: {
        [cleanMetaKey(META_MTIME)]: toMetaValue(mtime),
        [cleanMetaKey(META_ENCRYPTED)]: encrypted ? "true" : "false",
        [cleanMetaKey(META_ORIG_PATH)]: vaultPath,
      },
      // Content-Type is inferred automatically
    });

    const resp = await this.client.send(cmd);
    return resp.ETag ?? "";
  }

  /** Download file content from S3. Returns the bytes and metadata. */
  async downloadFile(
    vaultPath: string
  ): Promise<{ content: Uint8Array; mtime: number; encrypted: boolean } | null> {
    const key = this.toKey(vaultPath);
    try {
      const cmd = new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      });
      const resp = await this.client.send(cmd);

      if (!resp.Body) return null;

      // Convert the streaming body to Uint8Array
      const byteArray = await resp.Body.transformToByteArray();

      return {
        content: byteArray,
        mtime: fromMetaValue(
          resp.Metadata?.[cleanMetaKey(META_MTIME)],
          resp.LastModified ? resp.LastModified.getTime() : 0
        ),
        encrypted: resp.Metadata?.[cleanMetaKey(META_ENCRYPTED)] === "true",
      };
    } catch (err: any) {
      if (err.name === "NoSuchKey") return null;
      throw err;
    }
  }

  /** Delete a file from S3. */
  async deleteFile(vaultPath: string): Promise<void> {
    const key = this.toKey(vaultPath);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.config.bucket,
        Key: key,
      })
    );
  }

  /** Delete multiple files from S3 in parallel (batched). */
  async deleteFiles(vaultPaths: string[]): Promise<void> {
    // Batch deletions in parallel (S3 doesn't support multi-delete for all
    // compatible services, so we do individual deletes concurrently).
    const chunkSize = 10;
    for (let i = 0; i < vaultPaths.length; i += chunkSize) {
      const chunk = vaultPaths.slice(i, i + chunkSize);
      await Promise.all(chunk.map((p) => this.deleteFile(p)));
    }
  }
}
