import { createInitialProject } from './sample';
import { createInitialSpec, mergeOrphanRulesIntoSpec, reconcileProject, refreshRuleSetCache, upgradeProject } from './spec';
import { DRAFT_KEY, LEGACY_DRAFT_KEY, loadJSON, loadSpec, persistJSON, saveSpec } from './storage';
import type { ProjectState, SpecTable, WorkspaceBootstrap } from './types';

function normalizeLegacyDraft(parsed: Partial<ProjectState>): ProjectState {
  return {
    id: parsed.id ?? `braille-course-${Date.now()}`,
    title: parsed.title ?? '未命名课文',
    author: parsed.author ?? '',
    schemaVersion: 1,
    activeRuleSetId: parsed.activeRuleSetId ?? 'ueb-teaching',
    ruleSets: parsed.ruleSets ?? [],
    specRevision: 0,
    lines: parsed.lines ?? [],
    selectedLineId: parsed.selectedLineId ?? '',
    issues: parsed.issues ?? [],
    versions: parsed.versions ?? [],
    lastCheckedAt: parsed.lastCheckedAt ?? new Date().toISOString(),
    updatedAt: parsed.updatedAt ?? new Date().toISOString(),
  };
}

function normalizeV2Draft(parsed: Partial<ProjectState>, fallback: ProjectState): ProjectState {
  return {
    ...fallback,
    ...parsed,
    schemaVersion: 2,
    ruleSets: parsed.ruleSets?.length ? parsed.ruleSets : fallback.ruleSets,
    lines: parsed.lines ?? fallback.lines,
    issues: parsed.issues ?? [],
    versions: parsed.versions ?? [],
    specRevision: typeof parsed.specRevision === 'number' ? parsed.specRevision : 0,
  } as ProjectState;
}

/**
 * 启动时装载两侧数据：
 * 规范表（教研组）读不出来 → 课文稿用自身缓存照常打开；
 * 旧稿（v1）→ 按规范表补归属后整稿升级，原校对备注保留；
 * 规范表比稿子新 → 只对受条目变动影响的行对账重转，批准过的行结果变了就退回。
 */
export function bootstrapWorkspace(): WorkspaceBootstrap {
  const seeded = createInitialProject();
  const specLoad = loadSpec<SpecTable>();
  const draftLoad = loadJSON<ProjectState>(DRAFT_KEY);
  const legacyLoad = loadJSON<ProjectState>(LEGACY_DRAFT_KEY);

  // 1) 规范表读不出来：稿子照旧能改，规范侧只读
  if (specLoad.error && !specLoad.data) {
    const draft = draftLoad.data
      ? normalizeV2Draft(draftLoad.data, seeded.project)
      : legacyLoad.data
        ? normalizeLegacyDraft(legacyLoad.data)
        : seeded.project;
    return {
      spec: createInitialSpecTableSafe(draft, seeded.spec),
      project: draft,
      specReadable: false,
      specLoadError: specLoad.error,
      revertedLineIds: [],
    };
  }

  // 2) 没有任何稿子：用内置示例
  if (!draftLoad.data && !legacyLoad.data) {
    if (!specLoad.data) {
      saveSpecBestEffort(seeded.spec);
      persistBestEffort(DRAFT_KEY, seeded.project);
      return { spec: seeded.spec, project: seeded.project, specReadable: true, revertedLineIds: [] };
    }
    const refreshed = refreshRuleSetCache(seeded.project, specLoad.data);
    const { project } = reconcileOnOpen(refreshed, specLoad.data);
    return { spec: specLoad.data, project, specReadable: true, revertedLineIds: [] };
  }

  // 3) 旧稿升级（v1）：先把学校自定义条目补进规范表，再补归属、整稿对账
  if (!draftLoad.data && legacyLoad.data) {
    const legacy = normalizeLegacyDraft(legacyLoad.data);
    const spec = mergeOrphanRulesIntoSpec(specLoad.data ?? createInitialSpecTableSafe(legacy, seeded.spec), legacy.ruleSets);
    const { project, spec: upgradedSpec, revertedLineIds } = upgradeProject(legacy, spec);
    saveSpecBestEffort(upgradedSpec);
    persistBestEffort(DRAFT_KEY, project);
    return { spec: upgradedSpec, project, specReadable: true, upgradedFromRevision: 1, revertedLineIds };
  }

  // 4) 当前稿子 + 规范表：打开时按条目变动对账
  const draft = normalizeV2Draft((draftLoad.data ?? legacyLoad.data)!, seeded.project);
  if (!specLoad.data) {
    const spec = createInitialSpecTableSafe(draft, seeded.spec);
    saveSpecBestEffort(spec);
    const { project, revertedLineIds } = reconcileOnOpen(draft, spec);
    return { spec, project, specReadable: true, revertedLineIds };
  }

  const { project, revertedLineIds } = reconcileOnOpen(draft, specLoad.data);
  return { spec: specLoad.data, project, specReadable: true, revertedLineIds };
}

function reconcileOnOpen(draft: ProjectState, spec: SpecTable): { project: ProjectState; revertedLineIds: string[] } {
  if (spec.revision <= draft.specRevision) {
    return { project: refreshRuleSetCache(draft, spec), revertedLineIds: [] };
  }
  const cached = refreshRuleSetCache(draft, spec);
  const { project, revertedLineIds } = reconcileProject(cached, spec, cached.ruleSets);
  persistBestEffort(DRAFT_KEY, project);
  return { project, revertedLineIds };
}

/** 规范表缺失时：优先用稿子缓存里的条目生成；缓存也没有再退回内置示例 */
function createInitialSpecTableSafe(draft: ProjectState, seeded: SpecTable): SpecTable {
  return draft.ruleSets.length ? createInitialSpec(draft.ruleSets) : seeded;
}

function saveSpecBestEffort(spec: SpecTable): void {
  try {
    saveSpec(spec);
  } catch {
    // 教研组侧保存失败不阻塞学校打开稿子
  }
}

function persistBestEffort(key: string, value: unknown): void {
  try {
    persistJSON(key, value);
  } catch {
    // 启动阶段的落盘失败交给应用内的重试机制接管
  }
}
