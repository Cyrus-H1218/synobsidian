<p align="center">
  <img src="https://raw.githubusercontent.com/synobsidian/synobsidian/main/assets/logo.svg" alt="SynObsidian Logo" width="120" />
</p>

<h1 align="center">SynObsidian</h1>

<p align="center">
  <strong>End-to-end encrypted cross-device sync for Obsidian via S3-compatible storage.</strong>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#installation">Installation</a> ·
  <a href="#setup">Setup</a> ·
  <a href="#usage">Usage</a> ·
  <a href="#encryption">Encryption</a> ·
  <a href="#faq">FAQ</a>
</p>

---

## Why SynObsidian?

You write notes on your Windows PC. You read them on your iPad. You want everything in sync — **without paying a monthly subscription** and **without your plain-text notes sitting unencrypted in someone else's cloud**.

SynObsidian gives you **zero-cost, private sync** by piggybacking on S3-compatible object storage (free tiers from Cloudflare R2, Backblaze B2, Tencent COS, Alibaba OSS, etc.), with **AES-256-GCM encryption** applied before your notes ever leave your device.

| | Obsidian Sync | Remotely Save | **SynObsidian** |
|---|---|---|---|
| Price | $5/mo | Free | **Free** |
| E2E Encryption | ✅ | Optional | **✅ Built-in by default** |
| Backends | Proprietary | 10+ services | **S3-compatible (R2, B2, COS, OSS, MinIO…)** |
| Complexity | Zero-config | High (many options) | **Minimal — 3 settings fields** |
| iOS/iPad | ✅ | ✅ | **✅** |

---

## Features

- 🔄 **Bidirectional hash-based differential sync** — only changed files are transferred
- 🔐 **AES-256-GCM end-to-end encryption** — your notes are encrypted *before* upload; the cloud provider never sees plaintext
- ☁️ **Any S3-compatible storage** — Cloudflare R2 (10 GB free), Backblaze B2 (10 GB free), Tencent COS (50 GB free), Alibaba OSS, AWS S3, MinIO, etc.
- ⚡ **Three sync modes** — full bidirectional, push-only, pull-only
- 🛡 **Safety guards** — aborts if >50% of files would change; deleted files are backed up to `_trash/`
- 📝 **Smart conflict resolution** — newer version wins, older version saved as `.conflict-YYYYMMDD-HHmmss.md`
- 📱 **Works everywhere** — Windows, macOS, Linux, iPad, iPhone, Android
- 🎛 **Minimal setup** — endpoint, bucket, access key. That's it.

---

## Installation

### From GitHub Releases (recommended)

1. Download the latest `synobsidian.zip` from the [Releases](https://github.com/synobsidian/synobsidian/releases) page.
2. Extract into `<vault>/.obsidian/plugins/synobsidian/`.
3. Restart Obsidian → **Settings → Community Plugins** → enable **SynObsidian**.

### Manual (build from source)

```bash
git clone https://github.com/synobsidian/synobsidian.git
cd synobsidian
npm install
npm run build
```

Then copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/synobsidian/`.

### iPad / iPhone

1. Transfer the three files (`main.js`, `manifest.json`, `styles.css`) to your iPad via AirDrop or iCloud.
2. Open the **Files** app → navigate to your Obsidian vault → `.obsidian/plugins/`.
3. Create a folder named `synobsidian` and paste the files there.
4. Enable the plugin in Obsidian mobile.

> **Tip:** Show hidden folders in Files.app: tap the three-dots menu → **View Options** → **Show All Extensions**.

---

## Setup

### 1. Create an S3-compatible bucket

Pick any provider with a free tier:

| Provider | Free Tier | Setup Time |
|----------|-----------|------------|
| [Cloudflare R2](https://dash.cloudflare.com/) | 10 GB | 3 min |
| [Backblaze B2](https://secure.backblaze.com/) | 10 GB | 3 min |
| [Tencent Cloud COS](https://console.cloud.tencent.com/cos) | 50 GB | 2 min (WeChat/Alipay) |
| [Alibaba Cloud OSS](https://oss.console.aliyun.com/) | 5 GB | 3 min (Alipay) |
| [MinIO](https://min.io/) (self-hosted) | Unlimited | 10 min |

### 2. Generate API credentials

- Create an **Access Key** / **API Key** with read+write permissions on the bucket.
- Copy the **Access Key ID** and **Secret Access Key**.

### 3. Configure CORS on the bucket

The bucket must accept cross-origin requests from Obsidian. Add a CORS policy:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "DELETE", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": [
      "ETag",
      "x-amz-meta-mtime",
      "x-amz-meta-encrypted",
      "x-amz-meta-orig-path"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

### 4. Fill in plugin settings

Open **Settings → SynObsidian** in Obsidian:

| Field | Example |
|-------|---------|
| S3 Endpoint | `https://<account>.r2.cloudflarestorage.com` |
| Region | `auto` or `us-east-1` |
| Bucket Name | `my-obsidian-vault` |
| Access Key ID | `abc123...` |
| Secret Access Key | `••••••••` |
| Enable Encryption | ✅ on |
| Encryption Password | A strong passphrase (same on all devices!) |

Click **Test Connection** — if you see ✅, you're ready.

### 5. Sync!

- **First device:** run `Ctrl+P → SynObsidian: Push to cloud only` to upload everything.
- **Second device:** run `Ctrl+P → SynObsidian: Pull from cloud only` to download everything.
- **Daily use:** click the ⟳ ribbon icon (or run `SynObsidian: Full sync`).

---

## Usage

### Commands

| Command | What it does |
|---------|--------------|
| **Full bidirectional sync** | Uploads local changes, downloads remote changes, resolves conflicts. |
| **Push to cloud only** | Uploads local changes only; ignores remote changes. |
| **Pull from cloud only** | Downloads remote changes only; ignores local changes. |

### Ribbon icon

Click the ⟳ icon in the left ribbon to trigger a full sync.

### Status bar

The bottom status bar shows the last sync time. During sync it shows live progress ("Syncing... 12/45").

### Conflict handling

If the same file is edited on both devices between syncs:

- **Newer wins** (default): the newer version is kept, the older one is saved as `file.conflict-20260630-142200.md`.
- **Manual**: both versions are kept; no automatic overwrite.

You can choose the strategy in the plugin settings.

---

## Encryption

SynObsidian uses **AES-256-GCM** via the [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API) (available in all modern browsers and Electron).

### How it works

```
Your password
     │
     ▼
 PBKDF2 (600,000 iterations, SHA-256)
     │
     ▼
 AES-256-GCM key ─── encrypt ───▶ ciphertext + IV + auth tag
     │
     ▼
 Uploaded to S3 (provider never sees the key or plaintext)
```

- **Salt** is derived deterministically from your vault name — the same password works across devices automatically.
- **IV** is randomly generated per file (12 bytes).
- **Auth tag** (16 bytes) is appended by GCM, preventing tampering.
- **Encrypted files** are prefixed with a magic header (`SOE1`) so the plugin can identify them.

> ⚠ Use the **same encryption password on every device**. If you change your password, you must re-sync all files.

---

## Configuration Reference

### Plugin data

Settings are stored in `<vault>/.obsidian/plugins/synobsidian/data.json`:

```json
{
  "settings": {
    "s3Endpoint": "https://...",
    "s3Region": "auto",
    "s3Bucket": "my-vault",
    "s3AccessKeyId": "...",
    "s3SecretAccessKey": "...",
    "s3PathPrefix": "obsidian/",
    "s3ForcePathStyle": true,
    "enableEncryption": true,
    "encryptionPassword": "...",
    "excludePatterns": ".obsidian/\n.trash/\n.excalidraw",
    "conflictStrategy": "newer",
    "encryptionSaltHex": "..."
  },
  "lastSnapshot": { ... },
  "lastSyncTime": 1719750123456
}
```

### Exclude patterns

One glob pattern per line. Examples:

```
.obsidian/
.trash/
*.excalidraw
templates/
attachments/movies/*
```

---

## Building & Development

```bash
# Install dependencies
npm install

# Development (watch mode)
npm run dev

# Production build
npm run build

# Type check only
npm run lint
```

### Project structure

```
synobsidian/
├── src/
│   ├── main.ts          # Plugin entry point
│   ├── settings.ts      # Settings tab UI
│   ├── s3Backend.ts     # S3-compatible storage operations
│   ├── encrypt.ts       # AES-256-GCM encryption
│   ├── fileIndex.ts     # Local file indexing & diffing
│   ├── syncEngine.ts    # Core sync algorithm
│   └── utils.ts         # Helpers
├── esbuild.config.mjs   # Build configuration
├── manifest.json        # Obsidian plugin manifest
├── styles.css           # Plugin styles
└── tsconfig.json        # TypeScript configuration
```

### Tech stack

- **TypeScript** + **esbuild** for building
- **@aws-sdk/client-s3** for S3 API calls (works in browser/Electron)
- **Web Crypto API** for AES-256-GCM encryption (zero JS crypto dependencies)

---

## FAQ

### Do I need an Obsidian Sync subscription?

No. This plugin replaces Obsidian Sync entirely, using your own cloud storage.

### Is it safe?

Yes. With encryption enabled, your notes are encrypted before leaving your device. The cloud storage provider only sees encrypted blobs. Even if the bucket is compromised, your notes are protected by AES-256-GCM with a 600,000-iteration PBKDF2 key derivation.

### What happens if I forget my encryption password?

Encrypted files cannot be recovered without the password. **Store it in a password manager.**

### Does it work on iPhone / Android?

Yes. The plugin uses APIs that are available in both Electron (desktop) and mobile WebViews (iOS Safari, Android Chrome). It has been tested on:

- ✅ Windows 10/11
- ✅ macOS
- ✅ Linux
- ✅ iPad (iPadOS 16+)
- ✅ iPhone (iOS 16+)
- ✅ Android

### Does it sync plugin settings?

Currently, SynObsidian only syncs vault files (notes, attachments). It does **not** sync `.obsidian/` configuration. Use a separate method (e.g., git) for plugin settings if needed.

### What if a sync fails mid-way?

SynObsidian uses an "all-or-nothing snapshot" model. The snapshot is only updated after a successful sync. If a sync is interrupted, the next sync will detect the partial state and re-sync any files that don't match.

### Can I share a bucket across multiple vaults?

Yes! Use the **Path Prefix** setting to give each vault its own sub-directory within the bucket (e.g., `vault-work/`, `vault-personal/`).

---

## License

MIT © SynObsidian contributors

---

<p align="center">
  <sub>Made with ❤️ for the Obsidian community.</sub>
</p>
