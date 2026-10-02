import { analyzeSingleLine, transcribeLine } from './braille';
import type {
  ProjectState,
  ProofIssue,
  RuleSet,
  SpecChange,
  SpecChangeKind,
  SpecEntry,
  SpecRuleSetProfile,
  SpecTable,
  TextbookLine,
  TranscriptionRule,
} from './types';

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const CHANGE_LIMIT = 200;

function nowIso(): string {
  return new Date().toISOString();
}

function bump(spec: SpecTable, entries: SpecEntry[]): SpecTable {
  return { ...spec, entries, revision: spec.revision + 1, updatedAt: nowIso() };
}

function recordChange(
  spec: SpecTable,
  kind: SpecChangeKind,
  entryId: string,
  label: string,
  extra?: Partial<SpecChange>,
): { spec: SpecTable; change: SpecChange } {
  const change: SpecChange = {
    id: uid('change'),
    revision: spec.revision,
    kind,
    entryId,
    label,
    at: nowIso(),
    ...extra,
  };
  return {
    spec: { ...spec, changes: [change, ...spec.changes].slice(0, CHANGE_LIMIT) },
    change,
  };
}

/* ---------------------------------- 种子 ---------------------------------- */

/** 从一套旧版内嵌规则集生成规范表条目（保留稳定 id，归属天然能接上） */
export function entriesFromRules(rules: TranscriptionRule[]): SpecEntry[] {
  return rules.map((rule) => ({
    id: rule.id,
    source: rule.source,
    output: rule.output,
    kind: rule.kind,
    enabled: rule.enabled,
    suspicious: rule.suspicious,
    description: rule.description,
    aliases: [],
    tombstoned: false,
  }));
}

export function profilesFromRuleSets(ruleSets: RuleSet[]): SpecRuleSetProfile[] {
  return ruleSets.map((set) => {
    const globallyEnabled = new Set(
      // 以第一个规则集为基准，无法在所有规则集中都启用的条目记为该集额外停用
      ruleSets[0]?.rules.filter((rule) => rule.enabled).map((rule) => rule.specEntryId ?? rule.id) ?? [],
    );
    return {
      id: set.id,
      name: set.name,
      description: set.description,
      contractions: set.contractions,
      hyphenMode: set.hyphenMode,
      disabledEntryIds: set.rules
        .filter((rule) => !rule.enabled && globallyEnabled.has(rule.specEntryId ?? rule.id))
        .map((rule) => rule.specEntryId ?? rule.id),
    };
  });
}

export function createInitialSpec(ruleSets: RuleSet[]): SpecTable {
  // 三个内置规则集共用同一批条目，按条目 id 去重
  const byId = new Map<string, SpecEntry>();
  ruleSets.forEach((set) => {
    entriesFromRules(set.rules).forEach((entry) => {
      if (!byId.has(entry.id)) byId.set(entry.id, entry);
    });
  });
  return {
    id: 'spec-braille-main',
    owner: '教研组',
    revision: 1,
    updatedAt: nowIso(),
    entries: [...byId.values()],
    profiles: profilesFromRuleSets(ruleSets),
    changes: [],
  };
}

/* ------------------------------ 规范 → 规则视图 ----------------------------- */

export function specToRuleSets(spec: SpecTable): RuleSet[] {
  const liveEntries = spec.entries.filter((entry) => !entry.tombstoned);
  return spec.profiles.map((profile) => {
    const extraDisabled = new Set(profile.disabledEntryIds);
    const rules: TranscriptionRule[] = liveEntries.map((entry) => ({
      id: entry.id,
      source: entry.source,
      output: entry.output,
      kind: entry.kind,
      enabled: entry.enabled && !extraDisabled.has(entry.id),
      suspicious: entry.suspicious,
      description: entry.description,
      specEntryId: entry.id,
      specRevision: spec.revision,
    }));
    return {
      id: profile.id,
      name: profile.name,
      description: profile.description,
      contractions: profile.contractions,
      hyphenMode: profile.hyphenMode,
      rules,
    };
  });
}

/** 旧名字 / 墓碑 id → 现行条目 id，用于给旧 token 找回归属 */
export function specAliasMap(spec: SpecTable): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of spec.entries) {
    if (entry.tombstoned && entry.mergedInto) {
      map.set(entry.id, entry.mergedInto);
      continue;
    }
    if (entry.tombstoned) continue;
    map.set(entry.id, entry.id);
    for (const alias of entry.aliases) map.set(alias, entry.id);
  }
  return map;
}

/* -------------------------------- 条目变更 -------------------------------- */

/** 教研组改动一个条目。换名（source 变了）单独留痕，供旧稿下次打开跟着重转 */
export function editSpecEntry(
  spec: SpecTable,
  entryId: string,
  patch: Partial<Pick<SpecEntry, 'source' | 'output' | 'kind' | 'enabled' | 'suspicious' | 'description'>>,
  ruleSetId?: string,
): SpecTable {
  const entry = spec.entries.find((item) => item.id === entryId);
  if (!entry) return spec;

  const renamed = patch.source !== undefined && patch.source !== entry.source;
  const nextEntry: SpecEntry = {
    ...entry,
    ...patch,
    aliases: renamed && entry.source ? Array.from(new Set([...entry.aliases, entry.source])) : entry.aliases,
  };
  let next = bump(spec, spec.entries.map((item) => (item.id === entryId ? nextEntry : item)));

  const label = renamed
    ? `条目“${entry.source}”换名为“${nextEntry.source}”`
    : patch.output !== undefined && patch.output !== entry.output
      ? `条目“${nextEntry.source}”盲文改为 ${nextEntry.output}`
      : patch.enabled !== undefined && patch.enabled !== entry.enabled
        ? `条目“${nextEntry.source}”${patch.enabled ? '启用' : '停用'}`
        : `条目“${nextEntry.source}”被修订`;

  ({ spec: next } = recordChange(next, renamed ? 'rename' : 'modify', entryId, label, {
    ruleSetId,
  }));
  return next;
}

export function addSpecEntry(spec: SpecTable, entry: Omit<SpecEntry, 'aliases' | 'tombstoned'>): SpecTable {
  let next = bump(spec, [...spec.entries, { ...entry, aliases: [], tombstoned: false }]);
  ({ spec: next } = recordChange(next, 'add', entry.id, `新增条目“${entry.source}”`));
  return next;
}

/** 两条并成一条：目标条目吸收旧名，被并条目立墓碑；引用旧条目的行下次打开跟着重转 */
export function mergeSpecEntries(spec: SpecTable, fromId: string, intoId: string): SpecTable {
  const from = spec.entries.find((item) => item.id === fromId);
  const into = spec.entries.find((item) => item.id === intoId);
  if (!from || !into || fromId === intoId) return spec;

  const entries = spec.entries.map((item) => {
    if (item.id === intoId) {
      return {
        ...item,
        aliases: Array.from(new Set([...item.aliases, from.source, ...from.aliases])),
      };
    }
    if (item.id === fromId) {
      return { ...item, tombstoned: true, mergedInto: intoId };
    }
    return item;
  });
  let next = bump(spec, entries);
  ({ spec: next } = recordChange(next, 'merge', intoId, `条目“${from.source}”并入“${into.source}”`, {
    fromEntryId: fromId,
  }));
  return next;
}

export function deleteSpecEntry(spec: SpecTable, entryId: string): SpecTable {
  const entry = spec.entries.find((item) => item.id === entryId);
  if (!entry) return spec;
  let next = bump(spec, spec.entries.filter((item) => item.id !== entryId));
  ({ spec: next } = recordChange(next, 'delete', entryId, `条目“${entry.source}”被删除`));
  return next;
}

/** 规则集级配置变化（启停缩写、连字模式、该集额外停用条目）会影响整个规则集的转写结果 */
export function updateSpecProfile(spec: SpecTable, profileId: string, patch: Partial<SpecRuleSetProfile>): SpecTable {
  const profile = spec.profiles.find((item) => item.id === profileId);
  if (!profile) return spec;
  let next: SpecTable = {
    ...spec,
    revision: spec.revision + 1,
    updatedAt: nowIso(),
    profiles: spec.profiles.map((item) => (item.id === profileId ? { ...item, ...patch } : item)),
  };
  ({ spec: next } = recordChange(next, 'profile', profileId, `规则集“${profile.name}”配置调整`, { ruleSetId: profileId }));
  return next;
}

/* -------------------------------- 对账重转 -------------------------------- */

function changeDay(change: SpecChange): string {
  return change.at.slice(0, 10);
}

/** 变更影响到的规范条目 id 集合（合并沿墓碑继续追溯） */
function affectedEntryIds(changes: SpecChange[], aliasMap: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const change of changes) {
    const resolved = aliasMap.get(change.entryId) ?? change.entryId;
    ids.add(resolved);
    if (change.fromEntryId) ids.add(aliasMap.get(change.fromEntryId) ?? change.fromEntryId);
  }
  return ids;
}

/** 转写并沿别名/墓碑回填规范条目归属 */
function transcribeLineWithRules(source: string, ruleSet: RuleSet, continuesPrevious: boolean, aliases: Map<string, string>) {
  const tokens = transcribeLine(source, ruleSet, continuesPrevious);
  for (const token of tokens) {
    if (!token.specEntryId && token.ruleId) {
      const resolved = aliases.get(token.ruleId);
      if (resolved) token.specEntryId = resolved;
    }
  }
  return tokens;
}

export interface ReconcileResult {
  project: ProjectState;
  revertedLineIds: string[];
  appliedChanges: SpecChange[];
}

/**
 * 用规范表给课文稿对账：
 * - 条目一改动，用过它的课文行重算；
 * - 条目换名 / 两条并一条，旧引用按别名与墓碑重新归属后跟着重转；
 * - 批准（或已校对）的行结果变了 → 退回待核对，备注写明动了哪个条目；
 * - 只动受影响的行，其余行原样保留（兼容旧校对备注）。
 */
export function reconcileProject(
  project: ProjectState,
  spec: SpecTable,
  ruleSets: RuleSet[],
  options: { forceAll?: boolean; baselineRevision?: number } = {},
): ReconcileResult {
  const ruleSet = ruleSets.find((set) => set.id === project.activeRuleSetId) ?? ruleSets[0];
  if (!ruleSet) return { project, revertedLineIds: [], appliedChanges: [] };

  const aliases = specAliasMap(spec);
  const pending = options.forceAll
    ? spec.changes
    : spec.changes.filter((change) => change.revision > (options.baselineRevision ?? project.specRevision));
  if (!options.forceAll && pending.length === 0 && project.specRevision >= spec.revision) {
    return { project, revertedLineIds: [], appliedChanges: [] };
  }

  const profileWide = pending.some((change) => change.kind === 'profile' && (!change.ruleSetId || change.ruleSetId === ruleSet.id));
  const affected = profileWide ? null : affectedEntryIds(pending, aliases);
  const labelByEntry = new Map<string, string[]>();
  for (const change of pending) {
    const ids = [change.entryId];
    if (change.fromEntryId) ids.push(change.fromEntryId);
    for (const rawId of ids) {
      const id = aliases.get(rawId) ?? rawId;
      labelByEntry.set(id, [...(labelByEntry.get(id) ?? []), change.label]);
    }
  }

  const revertedLineIds: string[] = [];
  const lines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  project.lines.forEach((line, index) => {
    const applied = new Set(line.appliedChangeIds ?? []);
    const newForLine = pending.filter((change) => !applied.has(change.id));
    const referenced = new Set<string>();
    for (const token of line.tokens) {
      const rawId = token.specEntryId ?? token.ruleId;
      if (!rawId) continue;
      // 旧 token 可能指向已被并掉的墓碑条目，沿别名解析到现行条目
      referenced.add(aliases.get(rawId) ?? rawId);
    }

    const hitsAffectedEntry = affected !== null && [...referenced].some((id) => affected.has(id));
    const isAffected = Boolean(options.forceAll || profileWide || hitsAffectedEntry);
    const relevantChanges = isAffected ? newForLine : [];

    if (!isAffected || relevantChanges.length === 0) {
      lines.push(line);
      // 未受影响的行：保留它原有的问题
      issues.push(...project.issues.filter((item) => item.lineId === line.id));
      return;
    }

    const previousLine = lines[index - 1] ?? project.lines[index - 1];
    const continuesPrevious = Boolean(previousLine?.source.trimEnd().endsWith('-'));
    const nextTokens = transcribeLineWithRules(line.source, ruleSet, continuesPrevious, aliases);
    const before = line.tokens.map((token) => token.braille).join('');
    const after = nextTokens.map((token) => token.braille).join('');
    const changed = before !== after;

    let status = line.status;
    let note = line.note;
    const wasSignedOff = line.status === 'approved' || line.status === 'reviewed';
    const labelsForLine = Array.from(new Set(
      [...referenced].flatMap((id) => labelByEntry.get(id) ?? []),
    ));
    if (profileWide && labelsForLine.length === 0) {
      labelsForLine.push(...new Set(pending.filter((change) => change.kind === 'profile').map((change) => change.label)));
    }
    if (options.forceAll && labelsForLine.length === 0) labelsForLine.push('按规范表重新核对');

    if (wasSignedOff && changed) {
      status = 'questionable';
      revertedLineIds.push(line.id);
      const day = changeDay(relevantChanges[0]);
      const suffix = `【${day} 规范变动退回：${labelsForLine.length ? labelsForLine.join('；') : '相关条目被修订'}，本行结果已重算，请重新核对】`;
      note = note && !note.includes(suffix) ? `${note.replace(/\s+$/, '')}\n${suffix}` : note || suffix;
    }

    const relevantIds = new Set<string>();
    relevantChanges.forEach((change) => relevantIds.add(change.id));
    const nextLine: TextbookLine = {
      ...line,
      tokens: nextTokens,
      status,
      note,
      appliedChangeIds: [...(line.appliedChangeIds ?? []), ...relevantIds],
    };
    const analyzed = analyzeSingleLine(nextLine, previousLine);
    lines.push(analyzed.line);

    const lineIssues = analyzed.issues;
    if (wasSignedOff && changed) {
      lineIssues.unshift({
        id: `issue-spec-${line.id}-${relevantChanges[0].id}`,
        lineId: line.id,
        specEntryId: referenced.values().next().value,
        severity: 'warning',
        code: 'spec-entry-changed',
        message: `${labelsForLine.join('；') || '规范条目有改动'}：本行批准结果已变化，已退回待核对。`,
        resolved: false,
      });
    }
    issues.push(...lineIssues);
  });

  const result: ProjectState = {
    ...project,
    ruleSets,
    specRevision: spec.revision,
    lines,
    issues,
    lastCheckedAt: nowIso(),
    updatedAt: nowIso(),
  };
  return { project: result, revertedLineIds, appliedChanges: pending };
}

/* -------------------------------- 旧稿升级 -------------------------------- */

/** 学校自定义、规范表里没有的条目：升级时补录进规范表（归属仍写在课文侧缓存里） */
export function mergeOrphanRulesIntoSpec(spec: SpecTable, ruleSets: RuleSet[]): SpecTable {
  let next = spec;
  for (const set of ruleSets) {
    for (const rule of set.rules) {
      const entryId = rule.specEntryId ?? rule.id;
      if (next.entries.some((entry) => entry.id === entryId)) continue;
      next = addSpecEntry(next, {
        id: entryId,
        source: rule.source,
        output: rule.output,
        kind: rule.kind,
        enabled: rule.enabled,
        suspicious: rule.suspicious,
        description: rule.description || '旧稿补录条目',
      });
    }
  }
  return next;
}

/**
 * 旧稿升级：按规范表给每个缓存规则补 specEntryId 归属（含换名/并条的别名追溯），
 * 然后整稿对账重转，批准行结果变了就退回，原校对备注保留。
 */
export function upgradeProject(project: ProjectState, spec: SpecTable): { project: ProjectState; spec: SpecTable; revertedLineIds: string[] } {
  let nextSpec = spec;

  const ruleSetsWithAttribution = project.ruleSets.map((set) => ({
    ...set,
    rules: set.rules.map<TranscriptionRule>((rule) => {
      if (rule.specEntryId && nextSpec.entries.some((entry) => entry.id === rule.specEntryId)) {
        return { ...rule, specRevision: nextSpec.revision };
      }
      const aliasMap = specAliasMap(nextSpec);
      const byId = aliasMap.get(rule.id);
      const byAlias = nextSpec.entries.find((entry) => !entry.tombstoned && (entry.source === rule.source || entry.aliases.includes(rule.source)));
      const specEntryId = byId ?? byAlias?.id;
      return specEntryId
        ? { ...rule, id: rule.id, specEntryId, specRevision: nextSpec.revision }
        : rule;
    }),
  }));

  // token 上的旧 ruleId 也按别名重新归属
  const aliases = specAliasMap(nextSpec);
  const upgradedLines = project.lines.map((line) => ({
    ...line,
    tokens: line.tokens.map((token) => {
      if (token.specEntryId) return token;
      const resolved = token.ruleId ? aliases.get(token.ruleId) : undefined;
      return resolved ? { ...token, specEntryId: resolved } : token;
    }),
  }));

  const freshRuleSets = specToRuleSets(nextSpec);
  const prepared: ProjectState = {
    ...project,
    ruleSets: freshRuleSets.length
      ? freshRuleSets.map((set) => {
          const old = ruleSetsWithAttribution.find((item) => item.id === set.id);
          // 规范表没有覆盖到的学校自定义规则继续挂在缓存里
          const custom = old?.rules.filter((rule) => !rule.specEntryId) ?? [];
          return { ...set, rules: [...set.rules, ...custom] };
        })
      : ruleSetsWithAttribution,
    lines: upgradedLines,
    specRevision: 0,
  };

  const { project: reconciled, revertedLineIds } = reconcileProject(prepared, nextSpec, prepared.ruleSets, {
    forceAll: true,
    baselineRevision: 0,
  });

  return {
    project: { ...reconciled, schemaVersion: 2 },
    spec: nextSpec,
    revertedLineIds,
  };
}

/** 把学校侧缓存规则替换成规范表视图；自定义规则（无 specEntryId）原样保留 */
export function refreshRuleSetCache(project: ProjectState, spec: SpecTable): ProjectState {
  const specSets = specToRuleSets(spec);
  const ruleSets = specSets.map((set) => {
    const old = project.ruleSets.find((item) => item.id === set.id);
    const custom = old?.rules.filter((rule) => !rule.specEntryId) ?? [];
    return { ...set, rules: [...set.rules, ...custom] };
  });
  return { ...project, ruleSets };
}
