export type RuleKind = 'letter' | 'number' | 'punctuation' | 'contraction' | 'special';
export type LineStatus = 'unchecked' | 'reviewed' | 'questionable' | 'approved';
export type IssueSeverity = 'error' | 'warning' | 'info';

export interface TranscriptionRule {
  id: string;
  source: string;
  output: string;
  kind: RuleKind;
  enabled: boolean;
  suspicious: boolean;
  description: string;
  /** 条目版本：原文、输出、类型或启停发生变化时递增，用于判断引用行是否需要重算。 */
  revision: number;
  /** 并入本条目的旧条目 id（条目换名后迁移、两条并成一条时记录），旧引用下次打开按此重转。 */
  aliases: string[];
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  contractions: boolean;
  hyphenMode: 'cross-line' | 'inline';
  rules: TranscriptionRule[];
  updatedAt?: string;
}

export interface BrailleToken {
  id: string;
  text: string;
  braille: string;
  kind: RuleKind;
  ruleId?: string;
  suspicious: boolean;
  offset: number;
}

/** 行转录时引用某条目留下的归属印记。 */
export interface RuleStamp {
  revision: number;
  source: string;
}

export interface TextbookLine {
  id: string;
  source: string;
  tokens: BrailleToken[];
  status: LineStatus;
  note: string;
  continuesPrevious: boolean;
  continuesNext: boolean;
  /** 本行最近一次转录使用的规范表 id。 */
  ruleSetId?: string;
  /** 本行用到的规范条目及版本（归属），用于规范表改动后的定向重算。 */
  stamps?: Record<string, RuleStamp>;
}

export interface ProofIssue {
  id: string;
  lineId: string;
  tokenId?: string;
  ruleId?: string;
  severity: IssueSeverity;
  code: string;
  message: string;
  resolved: boolean;
}

/** 规范条目变更类型：修改、换名、合并、删除、新增、整表切换。 */
export type RuleChangeKind = 'edited' | 'renamed' | 'merged' | 'removed' | 'added' | 'switched';

export interface RuleChange {
  ruleId: string;
  kind: RuleChangeKind;
  /** 条目短名，用于列表展示。 */
  label: string;
  /** 完整描述，写进校对备注与问题，说明动了哪个条目。 */
  detail: string;
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
  activeRuleSetId: string;
  ruleSets: RuleSet[];
  lines: TextbookLine[];
  selectedLineId: string;
  issues: ProofIssue[];
  versions: VersionSnapshot[];
  lastCheckedAt: string;
  updatedAt: string;
}

/** 课文稿（学校侧维护），与规范表分开保存。 */
export type DraftDoc = Omit<ProjectState, 'ruleSets'>;

/** 规范表（教研组维护），独立存储、独立保存。 */
export interface StandardsDoc {
  id: string;
  owner: string;
  updatedAt: string;
  ruleSets: RuleSet[];
}

export interface HistoryState {
  past: ProjectState[];
  present: ProjectState;
  future: ProjectState[];
  lastAction: string;
}
