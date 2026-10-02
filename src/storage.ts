/**
 * 两侧数据各自维护：
 * - 规范表归教研组（SPEC_KEY），课文稿归学校（DRAFT_KEY）；
 * - 写入采用"先备份上一版、再写新值"，保存失败时上一版仍保留在 *.backup；
 * - 规范表读不出来时不抛出，调用方用缓存继续改稿。
 */

export const SPEC_KEY = 'sologsb-1010-spec-v1';
export const DRAFT_KEY = 'sologsb-1010-braille-project-v2';
/** 兼容旧稿（v1）的读取键 */
export const LEGACY_DRAFT_KEY = 'sologsb-1010-braille-project-v1';

export type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export interface LoadResult<T> {
  data: T | null;
  error?: string;
  hadBackup?: boolean;
}

function storageOrThrow(): Storage {
  if (typeof localStorage === 'undefined') throw new Error('本地存储不可用');
  return localStorage;
}

/** 浏览器隐身模式/配额满时 localStorage 会直接抛错，这里统一探测 */
export function storageAvailable(): boolean {
  try {
    const probe = '__storage_probe__';
    const store = storageOrThrow();
    store.setItem(probe, '1');
    store.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

export function loadJSON<T>(key: string): LoadResult<T> {
  try {
    const raw = storageOrThrow().getItem(key);
    if (!raw) return { data: null };
    return { data: JSON.parse(raw) as T };
  } catch (error) {
    // 主值损坏：尝试上一版备份，保住学校这边最近一次可用数据
    try {
      const backup = storageOrThrow().getItem(`${key}.backup`);
      if (backup) return { data: JSON.parse(backup) as T, error: (error as Error).message, hadBackup: true };
    } catch {
      // 备份也坏了，按没有数据处理
    }
    return { data: null, error: (error as Error).message };
  }
}

export function loadRaw(key: string): LoadResult<string> {
  try {
    const raw = storageOrThrow().getItem(key);
    return { data: raw };
  } catch (error) {
    return { data: null, error: (error as Error).message };
  }
}

/**
 * 安全保存：先把新值写到 .pending，写成功后才把当前值转为 .backup 并提交新值。
 * 这样无论哪一步失败，key 与 .backup 都停留在最近一次成功保存的版本（上一版先留着）。
 */
export function persistJSON(key: string, value: unknown): void {
  const store = storageOrThrow();
  const pendingKey = `${key}.pending`;
  const serialized = JSON.stringify(value);
  try {
    store.setItem(pendingKey, serialized);
  } catch (error) {
    throw new Error(`保存失败：${(error as Error).message}（上一版仍保留）`);
  }
  const previous = store.getItem(key);
  try {
    if (previous !== null) store.setItem(`${key}.backup`, previous);
    store.setItem(key, serialized);
    store.removeItem(pendingKey);
  } catch (error) {
    // 提交阶段失败：key 仍是上一版；尽量把未用的 pending 清掉
    try { store.removeItem(pendingKey); } catch { /* 忽略清理错误 */ }
    throw new Error(`保存失败：${(error as Error).message}（上一版仍保留）`);
  }
}

/** 读规范表：读不出来只返回错误，不阻断课文稿 */
export function loadSpec<T>(): LoadResult<T> {
  return loadJSON<T>(SPEC_KEY);
}

export function saveSpec(spec: unknown): void {
  persistJSON(SPEC_KEY, spec);
}

export function saveDraft(draft: unknown): void {
  persistJSON(DRAFT_KEY, draft);
}
