import { invoke } from "@tauri-apps/api/core";

export interface TargetInfo {
  id: string;
  label: string;
  kind: "shared" | "agent";
  /** 当前生效路径（候选中第一个被占用者）。 */
  path: string;
  /** 全部候选路径，用于判断外部事件是否影响该目标。 */
  paths: string[];
  /** 路径被占用（含悬空符号链接）。 */
  exists: boolean;
  size: number | null;
  mtime: number | null;
  isLink: boolean;
  /** 链接目标（已绝对化）。 */
  linkTarget: string | null;
  /** 跟随链接可读到文件内容。 */
  linkTargetExists: boolean;
  /** 目标就是 Pizzic 私有共享指令文件。 */
  linkTargetIsShared: boolean;
}

export interface FileSnapshot {
  text: string;
  mtime: number | null;
}

export interface ArchivedEntry {
  content: string;
  /** 停用时的前驱模块名（位置锚），启用时优先插回其之后。 */
  after: string | null;
}

/** 启动时发生过共享指令迁移，一次性投递。 */
export interface MigrationInfo {
  legacyPath: string;
  sharedPath: string;
  copiedBytes: number;
}

export interface LinkOutcome {
  /** 本次是否顺带创建了原本缺失的共享指令文件。 */
  createdShared: boolean;
  /** 原普通指令文件是否已被移入回收站（改指向已有链接时为 false）。 */
  trashedOriginal: boolean;
}

export const api = {
  listTargets: () =>
    invoke<{ home: string; targets: TargetInfo[]; migration: MigrationInfo | null }>(
      "list_targets",
    ),
  readFile: (path: string) => invoke<FileSnapshot>("read_file", { path }),
  writeFile: (path: string, text: string) => invoke<FileSnapshot>("write_file", { path, text }),
  linkToShared: (path: string) => invoke<LinkOutcome>("link_to_shared", { path }),
  deleteTarget: (path: string) => invoke<void>("delete_target", { path }),
  deleteLegacyShared: () => invoke<void>("delete_legacy_shared"),
  getDisabled: (path: string) => invoke<Record<string, ArchivedEntry>>("get_disabled_modules", { path }),
  setDisabled: (path: string, name: string, content: string | null, after: string | null = null) =>
    invoke<void>("set_disabled_module", { path, name, content, after }),
};
