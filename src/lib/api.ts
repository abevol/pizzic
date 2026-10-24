import { invoke } from "@tauri-apps/api/core";

export interface TargetInfo {
  id: string;
  label: string;
  kind: "shared" | "agent";
  path: string;
  exists: boolean;
  size: number | null;
  mtime: number | null;
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

export const api = {
  listTargets: () => invoke<{ home: string; targets: TargetInfo[] }>("list_targets"),
  readFile: (path: string) => invoke<FileSnapshot>("read_file", { path }),
  writeFile: (path: string, text: string) => invoke<FileSnapshot>("write_file", { path, text }),
  getDisabled: (path: string) => invoke<Record<string, ArchivedEntry>>("get_disabled_modules", { path }),
  setDisabled: (path: string, name: string, content: string | null, after: string | null = null) =>
    invoke<void>("set_disabled_module", { path, name, content, after }),
};
