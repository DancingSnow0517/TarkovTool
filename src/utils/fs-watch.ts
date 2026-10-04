/** File System Access / FileSystemObserver 公共基础设施：
 * 目录授权（句柄持久化到 IndexedDB，刷新后免重新选择）、类型声明、支持性检查。
 * 被截图位置追踪（stores/track.ts）和战局日志同步（stores/raidLog.ts）共用。 */

export interface FSObserverRecord {
  changedHandle: FileSystemHandle;
  relativePathComponents: string[];
  type: string;
}

export interface FSObserver {
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>;
  disconnect(): void;
}

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string }) => Promise<FileSystemDirectoryHandle>;
    FileSystemObserver?: new (
      callback: (records: FSObserverRecord[], observer: FSObserver) => void,
    ) => FSObserver;
  }
  interface FileSystemDirectoryHandle {
    /** lib.dom 未声明的异步迭代器：枚举目录下的子句柄 */
    values(): AsyncIterableIterator<FileSystemHandle>;
  }
}

/** lib.dom 的 FileSystemDirectoryHandle 未声明权限方法，这里补上 */
export type PermDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission(desc: { mode: "read" }): Promise<PermissionState>;
  requestPermission(desc: { mode: "read" }): Promise<PermissionState>;
};

/** 不支持时返回错误文本，支持返回 null */
export function checkFsSupport(): string | null {
  if (!window.showDirectoryPicker) {
    return "当前浏览器不支持目录访问，请使用最新版 Chrome / Edge";
  }
  if (!window.FileSystemObserver) {
    return "当前浏览器不支持 FileSystemObserver，请升级到 Chrome / Edge 129 以上版本";
  }
  return null;
}

/* ---- IndexedDB 句柄持久化 ---- */

const DB_NAME = "tarkov-tool-fs";
const DB_STORE = "handles";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadDirHandle(key: string): Promise<PermDirectoryHandle | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve((req.result as PermDirectoryHandle | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function saveDirHandle(key: string, handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    tx.objectStore(DB_STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 取目录句柄：优先用持久化句柄（申请权限），否则弹目录选择器并持久化。
 * forcePicker 为 true 时跳过持久化句柄，直接弹选择器（用于"重新选择"）。
 * 返回 null 表示用户取消或授权失败。必须在用户手势中调用。 */
export async function acquireDir(
  key: string,
  pickerId: string,
  forcePicker = false,
): Promise<PermDirectoryHandle | null> {
  let handle: PermDirectoryHandle | null = null;
  if (!forcePicker) {
    try {
      handle = await loadDirHandle(key);
    } catch (e) {
      console.warn("读取持久化目录句柄失败:", e);
    }
    if (handle && (await handle.requestPermission({ mode: "read" })) !== "granted") {
      handle = null;
    }
  }
  if (!handle) {
    try {
      handle = (await window.showDirectoryPicker!({ id: pickerId })) as PermDirectoryHandle;
    } catch (e) {
      console.warn("选择目录被取消或失败:", e);
      return null;
    }
    try {
      await saveDirHandle(key, handle);
    } catch (e) {
      console.warn("持久化目录句柄失败（不影响本次使用）:", e);
    }
  }
  return handle;
}
