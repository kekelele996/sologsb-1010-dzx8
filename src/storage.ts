import type { DraftDoc, ProjectState, RuleSet, StandardsDoc } from './types';

/**
 * 规范表归教研组、课文稿归学校，两边各自维护、分开保存：
 * - 规范表：STANDARDS_KEY
 * - 课文稿：DRAFT_KEY（写入前先留上一版，失败可回退、可重试）
 * - 旧版合并存储：LEGACY_KEY（打开时自动升级拆分）
 */
export const STANDARDS_KEY = 'sologsb-1010-standards-v2';
export const DRAFT_KEY = 'sologsb-1010-draft-v2';
const DRAFT_STAGE_KEY = 'sologsb-1010-draft-v2-stage';
const DRAFT_PREVIOUS_KEY = 'sologsb-1010-draft-v2-previous';
export const LEGACY_KEY = 'sologsb-1010-braille-project-v1';

export interface StandardsLoadResult {
  ruleSets: RuleSet[] | null;
  /** true 表示规范表读不出来（数据损坏或读取异常），调用方降级处理，稿子照旧能改。 */
  degraded: boolean;
}

export function readStandards(): StandardsLoadResult {
  try {
    const raw = localStorage.getItem(STANDARDS_KEY);
    if (!raw) return { ruleSets: null, degraded: false };
    const doc = JSON.parse(raw) as StandardsDoc;
    if (!doc || !Array.isArray(doc.ruleSets) || doc.ruleSets.length === 0) throw new Error('standards doc invalid');
    return { ruleSets: doc.ruleSets, degraded: false };
  } catch {
    return { ruleSets: null, degraded: true };
  }
}

export function writeStandards(ruleSets: RuleSet[]): void {
  const doc: StandardsDoc = {
    id: 'standards-1010',
    owner: '教研组',
    updatedAt: new Date().toISOString(),
    ruleSets,
  };
  localStorage.setItem(STANDARDS_KEY, JSON.stringify(doc));
}

function parseDraft(raw: string | null): DraftDoc | null {
  if (!raw) return null;
  try {
    const doc = JSON.parse(raw) as DraftDoc;
    return doc && Array.isArray(doc.lines) ? doc : null;
  } catch {
    return null;
  }
}

export function readDraft(): DraftDoc | null {
  // 上次保存若写到一半（暂存未清理），优先恢复学校侧的最新内容。
  const staged = parseDraft(localStorage.getItem(DRAFT_STAGE_KEY));
  if (staged) return staged;
  const current = parseDraft(localStorage.getItem(DRAFT_KEY));
  if (current) return current;
  // 主稿损坏时回退到上一版。
  return parseDraft(localStorage.getItem(DRAFT_PREVIOUS_KEY));
}

/**
 * 保存课文稿（学校侧）。先写暂存、再留上一版、最后替换主稿：
 * 任一步失败，上一版都还在，调用方可按学校这侧重试。
 */
export function writeDraft(doc: DraftDoc): void {
  const json = JSON.stringify(doc);
  localStorage.setItem(DRAFT_STAGE_KEY, json);
  const previous = localStorage.getItem(DRAFT_KEY);
  if (previous && previous !== json) {
    localStorage.setItem(DRAFT_PREVIOUS_KEY, previous);
  }
  localStorage.setItem(DRAFT_KEY, json);
  localStorage.removeItem(DRAFT_STAGE_KEY);
}

/** 读取旧版合并存储的稿子（v1：规范表与课文稿存在一起）。 */
export function readLegacyProject(): ProjectState | null {
  try {
    const raw = localStorage.getItem(LEGACY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ProjectState;
    return parsed && Array.isArray(parsed.lines) && Array.isArray(parsed.ruleSets) ? parsed : null;
  } catch {
    return null;
  }
}

/** 从项目状态中拆出学校侧的课文稿。 */
export function toDraftDoc(state: ProjectState): DraftDoc {
  const { ruleSets: _ruleSets, ...draft } = state;
  return draft;
}
