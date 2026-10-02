export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

/** 教研组规范表中的条目（按规则集分组启停、缩写开关与连字模式是规则集级配置） */
export interface SpecEntry {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
  /** 条目曾用过的名字（换名后，旧稿靠它找回归属） */
  aliases: string[];
  /** 两条并一条时，被并入条目留下的墓碑 */
  tombstoned: boolean;
  /** 并入了哪一条 */
  mergedInto?: string;
}

export interface SpecRuleSetProfile {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  /** 该规则集额外停用的条目（enabled=false 为全局停用，不记录在这里） */
  disabledEntryIds: string[];
}

export type SpecChangeKind = 'rename' | 'modify' | 'merge' | 'add' | 'delete' | 'profile';

export interface SpecChange {
  id: string;
  revision: number;
  kind: SpecChangeKind;
  entryId: string;
  /** 合并场景下被并掉的条目 */
  fromEntryId?: string;
  ruleSetId?: string;
  label: string;
  at: string;
}

/** 教研组维护的规范表，独立存储 */
export interface SpecTable {
  id: string;
  owner: string;
  revision: number;
  updatedAt: string;
  entries: SpecEntry[];
  profiles: SpecRuleSetProfile[];
  /** 最近的条目变更流水，打开旧稿时按它逐条对账 */
  changes: SpecChange[];
}

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
  /** 来源规范条目；学校自定义、尚未归属的规则为空 */
  specEntryId?: string;
  /** 该规则被确认时的规范表修订号 */
  specRevision?: number;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  /** token 归属到规范条目的记录 */
  specEntryId?: string;
  suspicious: boolean;
  offset: number;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
  /** 本行已经对过账的条目变更（幂等，避免重复退回、重复写备注） */
  appliedChangeIds?: string[];
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  specEntryId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

export interface VersionSnapshot {
  id: string;
  name: string;
  createdAt: string;
  action: string;
  snapshot: Omit<ProjectState, 'versions'>;
}

export interface ProjectState {
  id: string;
  title: string;
  author: string;
  schemaVersion: number;
  activeRuleSetId: string;
  /** 学校侧缓存的规则视图：规范表读不出来时照常用它转写、编辑 */
  ruleSets: RuleSet[];
  /** 缓存对应的规范表修订号；低于规范表就触发对账重转 */
  specRevision: number;
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  lastCheckedAt: string;
  updatedAt: string;
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}

/** 两侧数据的加载结果 */
export interface WorkspaceBootstrap {
  spec: SpecTable;
  project: ProjectState;
  /** 规范表读不出来：课文稿仍可改，但规范侧只读 */
  specReadable: boolean;
  specLoadError?: string;
  /** 本次打开是否做过旧稿升级/对账 */
  upgradedFromRevision?: number;
  revertedLineIds: string[];
}
