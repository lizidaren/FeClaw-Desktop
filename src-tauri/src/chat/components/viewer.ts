// =========================================================
// FeClaw Desktop — File Viewer Component (Phase 2A Desktop)
// =========================================================
//
// This module is inlined into file-manager.html as an ES module.
// Kept here as a reference source for documentation.
//
// Viewer logic handles three categories:
//   1. Images  — blob → data:URL → <img> tag
//   2. Text    — blob → text → <pre> (readonly) or <textarea> (editable)
//   3. Binary  — no preview; offer download
//
// Text extensions supported: txt md js ts py rs go java c cpp h css html json toml yaml yml sh bash xml sql
// Image extensions supported: png jpg jpeg gif webp svg bmp ico
//
// Editable files: Ctrl+S saves back to VFS via presigned PUT URL.
// Unsaved changes: tracked via viewerUnsaved flag; close prompts if dirty.
//
// ## Key functions (called from file-manager.html):
//
//   openFile(path: string, mode: "preview" | "edit")
//     → getVfsPreviewUrl(path) → fetch blob → detect type → render
//
//   saveFileContent(path: string, content: string)
//     → getVfsUploadUrl(path) → PUT to presigned URL
//
//   closeViewer()
//     → checks viewerUnsaved → confirm dialog if dirty
//
//   blobToDataURL(blob: Blob): Promise<string>
//     → FileReader.readAsDataURL
//
//   isEditable(ext: string): boolean
//     → list of editable text extensions
//
//   openLocally(path: string)
//     → downloadVfsFile(path) → invoke("open_local_file", {path})
//
//   downloadFile(path: string)
//     → downloadVfsFile(path) → anchor download trick
// =========================================================

// Re-exported types for documentation only (these live in Rust + HTML inline JS)
export interface FsEntry {
  name: string;
  type: "dir" | "file";
  size: number;
  mtime: number;
  content_type?: string;
}

export interface PreviewUrl {
  url: string;
  expires_at: number;
}

export interface UploadUrl {
  url: string;
  method: string;
  expires_at: number;
}

/**
 * Detect if a file extension is editable (text-based).
 */
export function isEditable(ext: string): boolean {
  const editable = [
    "txt", "md", "js", "ts", "py", "rs", "go", "java",
    "c", "cpp", "h", "css", "html", "json", "toml",
    "yaml", "yml", "sh", "bash", "xml", "sql",
  ];
  return editable.includes(ext?.toLowerCase());
}

/**
 * Detect if a file extension is a known image type.
 */
export function isImage(ext: string): boolean {
  return ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext?.toLowerCase());
}

/**
 * Convert a Blob to a data: URL for inline image embedding.
 */
export function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
