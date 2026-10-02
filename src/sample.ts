import { analyzeProject } from './braille';
import type { ProjectState, RuleSet, SpecTable, TranscriptionRule } from './types';
import { createInitialSpec } from './spec';

const letters = 'abcdefghijklmnopqrstuvwxyz'.split('').map<TranscriptionRule>((letter, index) => ({
  id: `letter-${letter}`,
  source: letter,
  output: '⠁⠃⠉⠙⠑⠋⠛⠓⠊⠚⠅⠇⠍⠝⠕⠏⠟⠗⠎⠞⠥⠧⠺⠭⠽⠵'[index],
  kind: 'letter',
  enabled: true,
  suspicious: false,
  description: '拉丁字母基础表',
  specEntryId: `letter-${letter}`,
  specRevision: 1,
}));

const punctuation: TranscriptionRule[] = [
  [',', '⠂', '逗号'], ['.', '⠲', '句号'], ['?', '⠦', '问号'], ['!', '⠖', '叹号'], [';', '⠆', '分号'], [':', '⠒', '冒号'], ['-', '⠤', '连字符'],
].map(([source, output, description]) => ({
  id: `punctuation-${source}`,
  source,
  output,
  kind: 'punctuation',
  enabled: true,
  suspicious: false,
  description,
  specEntryId: `punctuation-${source}`,
  specRevision: 1,
}));

const contractions: TranscriptionRule[] = [
  ['and', '⠯', false, '高频缩写'], ['the', '⠮', false, '高频缩写'], ['for', '⠿', true, '低年级教材可改为完整拼写'],
  ['of', '⠷', false, '高频缩写'], ['with', '⠾', false, '高频缩写'], ['ing', '⠬', true, '词尾缩写'],
  ['ed', '⠫', true, '词尾缩写'], ['er', '⠻', false, '词尾缩写'], ['ch', '⠡', false, '字母组合'], ['sh', '⠩', false, '字母组合'], ['th', '⠹', false, '字母组合'],
].map(([source, output, suspicious, description]) => ({
  id: `contraction-${source}`,
  source: String(source),
  output: String(output),
  kind: 'contraction',
  enabled: true,
  suspicious: Boolean(suspicious),
  description: String(description),
  specEntryId: `contraction-${source}`,
  specRevision: 1,
}));

const commonRules: TranscriptionRule[] = [
  { id: 'number-sign', source: '#', output: '⠼', kind: 'number', enabled: true, suspicious: false, description: '数字起始符', specEntryId: 'number-sign', specRevision: 1 },
  { id: 'capital-sign', source: 'capital', output: '⠠', kind: 'special', enabled: true, suspicious: false, description: '大写起始符', specEntryId: 'capital-sign', specRevision: 1 },
  ...letters,
  ...punctuation,
];

const ruleSets: RuleSet[] = [
  {
    id: 'ueb-teaching',
    name: 'UEB 教学规则',
    description: '英美盲文教学规则，默认启用常用缩写并将低年级易混淆缩写标为可疑。',
    contractions: true,
    hyphenMode: 'cross-line',
    rules: [...commonRules, ...contractions],
  },
  {
    id: 'literary-standard',
    name: '通用文学盲文',
    description: '保留完整缩写表，适合课外读本和工作表。',
    contractions: true,
    hyphenMode: 'inline',
    rules: [...commonRules, ...contractions.filter((rule) => !rule.suspicious)],
  },
  {
    id: 'spelling-first',
    name: '逐字拼读（无缩写）',
    description: '低年级识字课使用，关闭缩写和跨行连字符压缩。',
    contractions: false,
    hyphenMode: 'inline',
    rules: commonRules,
  },
];

const base: ProjectState = {
  id: 'braille-course-1010',
  title: '春天观察课 · 盲文教材',
  author: '资源教师 / 林老师',
  schemaVersion: 2,
  activeRuleSetId: 'ueb-teaching',
  specRevision: 1,
  ruleSets,
  selectedLineId: 'line-1',
  lines: [
    { id: 'line-1', source: 'The small seed is under the soil.', tokens: [], status: 'questionable', note: '“the”是否符合学生当前缩写进度？', continuesPrevious: false, continuesNext: false },
    { id: 'line-2', source: 'It needs water, light and time.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-3', source: 'By Friday, a green shoot appears.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-4', source: 'The gardener said, “Welcome, little sprout!”', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-5', source: 'Look-', tokens: [], status: 'unchecked', note: '下一行是同一单词，检查跨行断词。', continuesPrevious: false, continuesNext: false },
    { id: 'line-6', source: 'ing is learning!', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
    { id: 'line-7', source: 'Please measure 12 centimetres from the edge.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false },
  ],
  issues: [],
  versions: [],
  lastCheckedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

export function createInitialSpecTable(): SpecTable {
  return createInitialSpec(ruleSets);
}

export function createInitialProject(): { spec: SpecTable; project: ProjectState } {
  const spec = createInitialSpecTable();
  return { spec, project: analyzeProject({ ...base, specRevision: spec.revision }) };
}
