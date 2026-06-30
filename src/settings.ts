/**
 * Settings tab for SynObsidian plugin.
 *
 * Provides UI for configuring the S3 backend, encryption, and sync behaviour.
 * Settings are persisted via Plugin.loadData() / Plugin.saveData().
 */

import {
  App,
  PluginSettingTab,
  Setting,
  Notice,
} from "obsidian";

// ── Settings interface ────────────────────────────────────────────────

export interface SynObsidianSettings {
  // ── S3 ──
  s3Endpoint: string;
  s3Region: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  s3PathPrefix: string;
  s3ForcePathStyle: boolean;

  // ── Encryption ──
  enableEncryption: boolean;
  encryptionPassword: string;

  // ── Sync options ──
  /** One pattern per line; supports * and ? wildcards. */
  excludePatterns: string;
  /** "newer" = keep the newer version; "manual" = create conflict copies. */
  conflictStrategy: "newer" | "manual";

  // ── Internal ──
  /** Salt derived from vault name + password, stored as hex. */
  encryptionSaltHex: string;
}

export const DEFAULT_SETTINGS: SynObsidianSettings = {
  s3Endpoint: "",
  s3Region: "auto",
  s3Bucket: "",
  s3AccessKeyId: "",
  s3SecretAccessKey: "",
  s3PathPrefix: "",
  s3ForcePathStyle: true,

  enableEncryption: true,
  encryptionPassword: "",

  excludePatterns: [
    ".obsidian/",
    ".trash/",
    "_trash/",
    "*.excalidraw",
  ].join("\n"),
  conflictStrategy: "newer",

  encryptionSaltHex: "",
};

/** Human-readable labels for the three sync modes. */
export type SyncMode = "full" | "push" | "pull";

/**
 * Minimal plugin interface that the settings tab depends on.
 * This avoids a circular import from main.ts.
 */
export interface ISynObsidianPlugin {
  getSettings(): SynObsidianSettings;
  saveSettings(settings: SynObsidianSettings): Promise<void>;
  testConnection(): Promise<boolean>;
  triggerSync(mode: SyncMode): Promise<void>;
}

// ── Settings Tab ──────────────────────────────────────────────────────

export class SynObsidianSettingTab extends PluginSettingTab {
  private plugin: ISynObsidianPlugin;
  private settings: SynObsidianSettings;

  constructor(app: App, plugin: ISynObsidianPlugin) {
    super(app, plugin as any);
    this.plugin = plugin;
    this.settings = plugin.getSettings();
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("synobsidian-settings");

    // ── S3 Configuration ───────────────────────────────────────
    containerEl.createEl("h2", { text: "S3 存储配置" });

    const s3Desc = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    s3Desc.createEl("a", {
      text: "Cloudflare R2 文档",
      href: "https://developers.cloudflare.com/r2/",
    });
    s3Desc.appendText(" · ");
    s3Desc.createEl("a", {
      text: "Backblaze B2 文档",
      href: "https://www.backblaze.com/docs/cloud-storage-s3-compatible-api",
    });
    s3Desc.appendText(" · 请先在 S3 Bucket 上配置 CORS，允许跨域访问。");

    new Setting(containerEl)
      .setName("Endpoint URL")
      .setDesc("S3 兼容服务的端点地址，例如 https://<id>.r2.cloudflarestorage.com")
      .addText((text) =>
        text
          .setPlaceholder("https://<id>.r2.cloudflarestorage.com")
          .setValue(this.settings.s3Endpoint)
          .onChange(async (val) => {
            this.settings.s3Endpoint = val.trim();
            await this.plugin.saveSettings(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Region")
      .setDesc('区域标识，R2 使用 "auto"，B2 使用 "us-west-000" 等')
      .addText((text) =>
        text
          .setPlaceholder("auto")
          .setValue(this.settings.s3Region)
          .onChange(async (val) => {
            this.settings.s3Region = val.trim() || "auto";
            await this.plugin.saveSettings(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Bucket 名称")
      .setDesc("S3 Bucket 名称（建议为此插件单独创建一个 bucket）")
      .addText((text) =>
        text
          .setPlaceholder("my-obsidian-vault")
          .setValue(this.settings.s3Bucket)
          .onChange(async (val) => {
            this.settings.s3Bucket = val.trim();
            await this.plugin.saveSettings(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Path 前缀")
      .setDesc("可选。在 bucket 内的子目录，例如 obsidian/。多个 vault 可用不同前缀共享一个 bucket。")
      .addText((text) =>
        text
          .setPlaceholder("obsidian/")
          .setValue(this.settings.s3PathPrefix)
          .onChange(async (val) => {
            this.settings.s3PathPrefix = val.trim();
            await this.plugin.saveSettings(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Access Key ID")
      .setDesc("S3 兼容服务的 Access Key ID")
      .addText((text) =>
        text
          .setPlaceholder("Access Key ID")
          .setValue(this.settings.s3AccessKeyId)
          .onChange(async (val) => {
            this.settings.s3AccessKeyId = val.trim();
            await this.plugin.saveSettings(this.settings);
          })
      );

    new Setting(containerEl)
      .setName("Secret Access Key")
      .setDesc("S3 兼容服务的 Secret Access Key（仅保存在本地 data.json 中）")
      .addText((text) => {
        text
          .setPlaceholder("Secret Access Key")
          .setValue(this.settings.s3SecretAccessKey)
          .onChange(async (val) => {
            this.settings.s3SecretAccessKey = val.trim();
            await this.plugin.saveSettings(this.settings);
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("使用 Path-Style 寻址")
      .setDesc("R2、MinIO 等需要开启。标准 AWS S3 可关闭。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.s3ForcePathStyle)
          .onChange(async (val) => {
            this.settings.s3ForcePathStyle = val;
            await this.plugin.saveSettings(this.settings);
          })
      );

    // ── Connection test ─────────────────────────────────────────
    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("验证 S3 配置是否正确（点击按钮后等待几秒）")
      .addButton((btn) =>
        btn
          .setButtonText("测试连接")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("测试中...");
            btn.setDisabled(true);
            try {
              const ok = await this.plugin.testConnection();
              if (ok) {
                new Notice("✅ S3 连接成功！");
              } else {
                new Notice("❌ S3 连接失败，请检查配置");
              }
            } catch (e: any) {
              new Notice(`❌ 连接出错: ${e.message}`);
            }
            btn.setButtonText("测试连接");
            btn.setDisabled(false);
          })
      );

    // ── Encryption ──────────────────────────────────────────────
    containerEl.createEl("h2", { text: "端到端加密" });

    const encDesc = containerEl.createEl("p", {
      cls: "setting-item-description",
    });
    encDesc.setText(
      "使用 AES-256-GCM 加密。文件在上传前加密，云端存储密文。须在每台设备上设置相同的密码。"
    );

    new Setting(containerEl)
      .setName("启用加密")
      .setDesc("强烈建议启用。⚠ 关闭后新上传的文件将不加密，但已加密文件不会自动解密。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.settings.enableEncryption)
          .onChange(async (val) => {
            this.settings.enableEncryption = val;
            await this.plugin.saveSettings(this.settings);
            // Re-render to show/hide password field
            this.display();
          })
      );

    if (this.settings.enableEncryption) {
      new Setting(containerEl)
        .setName("加密密码")
        .setDesc(
          "用于 AES-256-GCM 加密的密码。所有设备必须使用相同的密码。修改密码后需要重新全量同步。"
        )
        .addText((text) => {
          text
            .setPlaceholder("输入密码（至少 8 个字符）")
            .setValue(this.settings.encryptionPassword)
            .onChange(async (val) => {
              this.settings.encryptionPassword = val;
              await this.plugin.saveSettings(this.settings);
            });
          text.inputEl.type = "password";
        });

      if (this.settings.encryptionSaltHex) {
        containerEl.createEl("p", {
          text: `✓ 加密已配置（Salt: ${this.settings.encryptionSaltHex.slice(0, 12)}...）`,
          cls: "setting-item-description",
        });
      }
    }

    // ── Sync options ────────────────────────────────────────────
    containerEl.createEl("h2", { text: "同步选项" });

    new Setting(containerEl)
      .setName("排除模式")
      .setDesc(
        "每行一个模式，支持 * 和 ? 通配符。匹配的文件/文件夹不会被同步。默认已排除 .obsidian/ 和 _trash/。"
      )
      .addTextArea((text) => {
        text
          .setPlaceholder(".obsidian/\n.trash/\n*.excalidraw")
          .setValue(this.settings.excludePatterns)
          .onChange(async (val) => {
            this.settings.excludePatterns = val;
            await this.plugin.saveSettings(this.settings);
          });
        text.inputEl.rows = 5;
        text.inputEl.style.width = "100%";
      });

    new Setting(containerEl)
      .setName("冲突处理策略")
      .setDesc(
        '"新版本胜出"：两台设备修改同一文件时，保留修改时间较新的版本，旧版本备份为 .conflict 文件。\n' +
          '"手动处理"：冲突时创建 .conflict 文件，不做自动覆盖。'
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("newer", "新版本胜出")
          .addOption("manual", "手动处理")
          .setValue(this.settings.conflictStrategy)
          .onChange(async (val) => {
            this.settings.conflictStrategy = val as "newer" | "manual";
            await this.plugin.saveSettings(this.settings);
          })
      );
  }
}
