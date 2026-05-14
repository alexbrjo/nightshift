import { invoke } from "@tauri-apps/api/core";
import {
  fileNameFromPath,
  getLanguage,
  type ProjectFileSnapshot,
} from "../features/project-editor/projectFileModel";

export interface HydratedProjectFile {
  path: string;
  baseline: string;
  snapshot: ProjectFileSnapshot;
}

export async function readProjectFileSnapshot(path: string, name = fileNameFromPath(path)): Promise<HydratedProjectFile> {
  try {
    const content = await invoke<string>("read_file", { relativePath: path });
    return {
      path,
      baseline: content,
      snapshot: {
        path,
        name,
        content,
        language: getLanguage(name),
      },
    };
  } catch (err) {
    return {
      path,
      baseline: "",
      snapshot: {
        path,
        name,
        content: "",
        language: getLanguage(name),
        error: String(err),
      },
    };
  }
}
