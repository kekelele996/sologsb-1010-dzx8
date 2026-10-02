import type {
  BrailleToken,
  ProofIssue,
  ProjectState,
  RuleChange,
  RuleSet,
  RuleStamp,
  TextbookLine,
  TranscriptionRule,
} from './types';

const LETTERS: Record<string, string> = {
  a: '⠁', b: '⠃', c: '⠉', d: '⠙', e: '⠑', f: '⠋', g: '⠛', h: '⠓', i: '⠊', j: '⠚',
  k: '⠅', l: '⠇', m: '⠍', n: '⠝', o: '⠕', p: '⠏', q: '⠟', r: '⠗', s: '⠎', t: '⠞',
  u: '⠥', v: '⠧', w: '⠺', x: '⠭', y: '⠽', z: '⠵',
};

const DEFAULT_PUNCTUATION: Record<string, string> = {
  ',': '⠂', ';': '⠆', ':': '⠒', '.': '⠲', '!': '⠖', '?': '⠦', '(': '⠐⠣', ')': '⠐⠜',
  '-': '⠤', '—': '⠠⠤', '"': '⠦', "'": '⠄', '/': '⠸⠌', '&': '⠈⠯', '@': '⠈⠁',
};

const DIGITS: Record<string, string> = {
  '0': '⠚', '1': '⠁', '2': '⠃', '3': '⠉', '4': '⠙', '5': '⠑', '6': '⠋', '7': '⠛', '8': '⠓', '9': '⠊',
};

const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

function activeRule(ruleSet: RuleSet, source: string, kind: TranscriptionRule['kind']): TranscriptionRule | undefined {
  return ruleSet.rules.find((rule) => rule.enabled && rule.kind === kind && rule.source.toLocaleLowerCase() === source.toLocaleLowerCase());
}

function matchContraction(ruleSet: RuleSet, source: string, index: number): TranscriptionRule | undefined {
  if (!ruleSet.contractions) return undefined;
  const before = source[index - 1] ?? '';
  if (/[\p{L}\p{N}]/u.test(before)) return undefined;

  const candidates = ruleSet.rules
    .filter((rule) => rule.enabled && rule.kind === 'contraction')
    .sort((a, b) => b.source.length - a.source.length);

  const rest = source.slice(index).toLocaleLowerCase();
  return candidates.find((rule) => rest.startsWith(rule.source.toLocaleLowerCase()));
}

function addToken(
  tokens: BrailleToken[],
  text: string,
  braille: string,
  kind: BrailleToken['kind'],
  offset: number,
  rule?: TranscriptionRule,
): void {
  tokens.push({
    id: uid('token'),
    text,
    braille,
    kind,
    ruleId: rule?.id,
    suspicious: Boolean(rule?.suspicious),
    offset,
  });
}

export function transcribeLine(source: string, ruleSet: RuleSet, continuesPrevious = false): BrailleToken[] {
  const tokens: BrailleToken[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const lower = char.toLocaleLowerCase();

    if (/\s/u.test(char)) {
      addToken(tokens, char, ' ', 'special', index);
      index += 1;
      continue;
    }

    const contraction = matchContraction(ruleSet, source, index);
    if (contraction) {
      addToken(tokens, source.slice(index, index + contraction.source.length), contraction.output, 'contraction', index, contraction);
      index += contraction.source.length;
      continue;
    }

    if (/\d/u.test(char)) {
      const start = index;
      let number = '';
      while (index < source.length && /\d/u.test(source[index])) {
        number += source[index];
        index += 1;
      }
      const numberRule = activeRule(ruleSet, '#', 'number');
      addToken(tokens, number, `${numberRule?.output ?? '⠼'}${[...number].map((digit) => DIGITS[digit]).join('')}`, 'number', start, numberRule);
      continue;
    }

    if (/[A-Z]/u.test(char)) {
      const capitalRule = activeRule(ruleSet, 'capital', 'special');
      addToken(tokens, char, `${capitalRule?.output ?? '⠠'}${LETTERS[lower]}`, 'letter', index, capitalRule);
      index += 1;
      continue;
    }

    if (/[a-z]/iu.test(char)) {
      const rule = activeRule(ruleSet, lower, 'letter');
      const output = rule?.output ?? LETTERS[lower] ?? '⠿';
      addToken(tokens, char, output, 'letter', index, rule);
      if (!rule) {
        addToken(tokens, '', '⟦未配置⟧', 'special', index);
      }
      index += 1;
      continue;
    }

    const punctuation = activeRule(ruleSet, char, 'punctuation') ?? activeRule(ruleSet, char.toLocaleLowerCase(), 'punctuation');
    if (punctuation) {
      addToken(tokens, char, punctuation.output, 'punctuation', index, punctuation);
      index += 1;
      continue;
    }

    const fallback = DEFAULT_PUNCTUATION[char];
    addToken(tokens, char, fallback ?? '⠿', 'punctuation', index);
    if (!fallback) addToken(tokens, '', '⟦无对应规则⟧', 'special', index);
    index += 1;
  }

  if (source.trimEnd().endsWith('-')) {
    addToken(tokens, '', ruleSet.hyphenMode === 'cross-line' ? '⠤↳' : '⠤', 'special', Math.max(0, source.length - 1));
  }

  if (continuesPrevious) {
    tokens.unshift({
      id: uid('token'),
      text: '',
      braille: '↳ ',
      kind: 'special',
      suspicious: true,
      offset: 0,
    });
  }

  return tokens;
}

/** 汇总一行转录用到的规范条目及版本，作为该行的归属印记。 */
export function stampsForTokens(tokens: BrailleToken[], ruleSet: RuleSet): Record<string, RuleStamp> {
  const stamps: Record<string, RuleStamp> = {};
  for (const token of tokens) {
    if (!token.ruleId || stamps[token.ruleId]) continue;
    const rule = ruleSet.rules.find((item) => item.id === token.ruleId);
    if (rule) stamps[token.ruleId] = { revision: rule.revision, source: rule.source };
  }
  return stamps;
}

/** 对比规范表前后两版，列出被改动、换名、合并或删除的条目。 */
export function diffRuleSets(before: RuleSet, after: RuleSet): RuleChange[] {
  const changes: RuleChange[] = [];
  const afterById = new Map(after.rules.map((rule) => [rule.id, rule]));

  for (const previous of before.rules) {
    const next = afterById.get(previous.id);
    if (!next) {
      const surviving = after.rules.find((rule) => rule.aliases.includes(previous.id));
      changes.push(surviving
        ? { ruleId: previous.id, kind: 'merged', label: surviving.source, detail: `条目「${previous.source}」已并入「${surviving.source}」` }
        : { ruleId: previous.id, kind: 'removed', label: previous.source, detail: `条目「${previous.source}」已删除` });
      continue;
    }
    if (next.revision === previous.revision) continue;
    if (next.source !== previous.source) {
      changes.push({ ruleId: next.id, kind: 'renamed', label: next.source, detail: `条目「${previous.source}」改名为「${next.source}」` });
    } else if (next.enabled !== previous.enabled) {
      changes.push({ ruleId: next.id, kind: 'edited', label: next.source, detail: `条目「${next.source}」已${next.enabled ? '启用' : '停用'}` });
    } else if (next.output !== previous.output) {
      changes.push({ ruleId: next.id, kind: 'edited', label: next.source, detail: `条目「${next.source}」输出由 ${previous.output} 改为 ${next.output}` });
    } else {
      changes.push({ ruleId: next.id, kind: 'edited', label: next.source, detail: `条目「${next.source}」已修改` });
    }
  }

  for (const rule of after.rules) {
    if (!before.rules.some((item) => item.id === rule.id)) {
      changes.push({ ruleId: rule.id, kind: 'added', label: rule.source, detail: `新增条目「${rule.source}」` });
    }
  }

  return changes;
}

/**
 * 打开稿子时按行上的归属印记核对当前规范表：
 * 条目被改动、换名（版本不同）、两条并成一条（旧 id 进入别名）或删除时，引用它的行需要跟着重转。
 */
export function detectRuleChanges(lines: TextbookLine[], ruleSet: RuleSet): RuleChange[] {
  const byId = new Map(ruleSet.rules.map((rule) => [rule.id, rule]));
  const found = new Map<string, RuleChange>();
  let switched = false;

  for (const line of lines) {
    if (line.ruleSetId && line.ruleSetId !== ruleSet.id) switched = true;
    for (const [ruleId, stamp] of Object.entries(line.stamps ?? {})) {
      if (found.has(ruleId)) continue;
      const rule = byId.get(ruleId);
      if (!rule) {
        const surviving = ruleSet.rules.find((item) => item.aliases.includes(ruleId));
        found.set(ruleId, surviving
          ? { ruleId, kind: 'merged', label: surviving.source, detail: `条目「${stamp.source}」已并入「${surviving.source}」` }
          : { ruleId, kind: 'removed', label: stamp.source, detail: `条目「${stamp.source}」已删除` });
      } else if (rule.revision !== stamp.revision) {
        found.set(ruleId, rule.source !== stamp.source
          ? { ruleId, kind: 'renamed', label: rule.source, detail: `条目「${stamp.source}」改名为「${rule.source}」` }
          : { ruleId, kind: 'edited', label: rule.source, detail: `条目「${rule.source}」已修改` });
      }
    }
  }

  const changes = [...found.values()];
  if (switched) {
    changes.unshift({ ruleId: '__ruleset__', kind: 'switched', label: ruleSet.name, detail: `规范表已切换为「${ruleSet.name}」` });
  }
  return changes;
}

function issue(
  line: TextbookLine,
  code: string,
  message: string,
  severity: ProofIssue['severity'],
  token?: BrailleToken,
): ProofIssue {
  return {
    id: uid('issue'),
    lineId: line.id,
    tokenId: token?.id,
    ruleId: token?.ruleId,
    severity,
    code,
    message,
    resolved: false,
  };
}

function analyzeLine(line: TextbookLine, previousLine?: TextbookLine): { line: TextbookLine; issues: ProofIssue[] } {
  const issues: ProofIssue[] = [];
  const tokenText = line.tokens.map((token) => token.braille).join('');
  const hasContinuation = line.source.trimEnd().endsWith('-');
  const previousContinues = Boolean(previousLine?.source.trimEnd().endsWith('-'));
  const nextLine = {
    ...line,
    continuesPrevious: previousContinues,
    continuesNext: hasContinuation,
  };

  if (hasContinuation) {
    issues.push(issue(nextLine, 'cross-line-hyphen', '此行以连字符结尾，已插入跨行连接标记；请核对断词位置。', 'warning', nextLine.tokens.at(-1)));
  }

  for (const token of nextLine.tokens) {
    if (token.suspicious) {
      issues.push(issue(nextLine, 'suspicious-rule', `规则“${token.text}”被标记为可疑转写。`, 'warning', token));
    }
    if (token.text && token.braille.includes('⟦')) {
      issues.push(issue(nextLine, 'unknown-symbol', `“${token.text}”没有可用的转写规则。`, 'error', token));
    }
  }

  if (tokenText.replace(/\s/g, '').length > 42) {
    issues.push(issue(nextLine, 'line-too-long', `盲文结果为 ${tokenText.replace(/\s/g, '').length} 格，建议重新分词。`, 'info'));
  }

  if (hasContinuation && nextLine.source.trimEnd().split(/\s+/).at(-1)?.replace(/-$/, '').length === 1) {
    issues.push(issue(nextLine, 'orphan-fragment', '断词后仅剩一个字母，教学排版中通常应整体移到下一行。', 'warning'));
  }

  if (issues.some((item) => item.severity === 'error')) {
    nextLine.status = 'questionable';
  } else if (issues.length > 0 && nextLine.status === 'unchecked') {
    nextLine.status = 'questionable';
  }

  return { line: nextLine, issues };
}

const joinedBraille = (tokens: BrailleToken[]) => tokens.map((token) => token.braille).join('');

/**
 * 重新转录并检查全部行。
 * 传入规范条目变更（changes）时：引用过这些条目的行随之重算，
 * 已批准的行若结果改变则退回待核对，并在备注与问题中写明动了哪个条目。
 */
export function analyzeProject(state: ProjectState, options?: { changes?: RuleChange[] }): ProjectState {
  const ruleSet = state.ruleSets.find((item) => item.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const changes = options?.changes ?? [];
  const nextLines: TextbookLine[] = [];
  const issues: ProofIssue[] = [];

  state.lines.forEach((line, index) => {
    const previousSourceContinues = Boolean(state.lines[index - 1]?.source.trimEnd().endsWith('-'));
    const tokens = transcribeLine(line.source, ruleSet, previousSourceContinues);
    const analyzed = analyzeLine(
      { ...line, tokens, ruleSetId: ruleSet.id, stamps: stampsForTokens(tokens, ruleSet) },
      state.lines[index - 1],
    );
    let nextLine = analyzed.line;
    const lineIssues = analyzed.issues;

    if (changes.length > 0 && line.status === 'approved' && joinedBraille(line.tokens) !== joinedBraille(tokens)) {
      const usedRuleIds = new Set(line.tokens.map((token) => token.ruleId).filter(Boolean) as string[]);
      const relevant = changes.filter((change) => usedRuleIds.has(change.ruleId));
      const details = (relevant.length > 0 ? relevant : changes).map((change) => change.detail).join('；');
      const marker = `[规范变更] ${details}，本行结果改变，退回待核对。`;
      nextLine = {
        ...nextLine,
        status: 'questionable',
        note: nextLine.note.includes(marker) ? nextLine.note : `${nextLine.note ? `${nextLine.note} ` : ''}${marker}`,
      };
      lineIssues.push(issue(nextLine, 'rule-changed', `${details}，本行原已批准，结果改变，已退回待核对。`, 'warning'));
    }

    nextLines.push(nextLine);
    issues.push(...lineIssues);
  });

  return {
    ...state,
    lines: nextLines,
    issues,
    lastCheckedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** 只改规则内容；影响转写的字段（原文/输出/类型/启停）变化时递增条目版本。 */
export function updateRuleInSet(ruleSet: RuleSet, ruleId: string, patch: Partial<TranscriptionRule>): RuleSet {
  return {
    ...ruleSet,
    updatedAt: new Date().toISOString(),
    rules: ruleSet.rules.map((rule) => {
      if (rule.id !== ruleId) return rule;
      const next = { ...rule, ...patch };
      const affectsTranscription = (['source', 'output', 'kind', 'enabled'] as const).some(
        (key) => key in patch && patch[key] !== rule[key],
      );
      return affectsTranscription ? { ...next, revision: rule.revision + 1 } : next;
    }),
  };
}

/** 两条并成一条：保留目标条目，把来源条目的 id 记入别名，引用来源条目的行下次打开跟着重转。 */
export function mergeRules(ruleSet: RuleSet, sourceId: string, targetId: string): RuleSet {
  const source = ruleSet.rules.find((rule) => rule.id === sourceId);
  if (!source || sourceId === targetId || !ruleSet.rules.some((rule) => rule.id === targetId)) return ruleSet;
  return {
    ...ruleSet,
    updatedAt: new Date().toISOString(),
    rules: ruleSet.rules
      .filter((rule) => rule.id !== sourceId)
      .map((rule) => (rule.id === targetId
        ? { ...rule, aliases: [...new Set([...rule.aliases, sourceId, ...source.aliases])], revision: rule.revision + 1 }
        : rule)),
  };
}

export function makeRule(source: string, output: string, suspicious: boolean, kind: TranscriptionRule['kind'] = 'contraction'): TranscriptionRule {
  return {
    id: uid('rule'),
    source,
    output,
    kind,
    enabled: true,
    suspicious,
    description: '自定义规则',
    revision: 1,
    aliases: [],
  };
}

function normalizeRuleSet(ruleSet: RuleSet): RuleSet {
  return {
    ...ruleSet,
    rules: ruleSet.rules.map((rule) => ({ ...rule, revision: rule.revision ?? 1, aliases: rule.aliases ?? [] })),
  };
}

function normalizeLine(line: TextbookLine & { remark?: string }): TextbookLine {
  return {
    ...line,
    tokens: line.tokens ?? [],
    status: line.status ?? 'unchecked',
    continuesPrevious: line.continuesPrevious ?? false,
    continuesNext: line.continuesNext ?? false,
    // 兼容旧校对备注：早期草稿可能使用 remark 字段或缺少 note。
    note: line.note ?? line.remark ?? '',
  };
}

/** 旧稿升级：补齐规范条目版本、别名与行归属等缺省字段，旧校对备注原样保留。 */
export function normalizeProject(state: ProjectState): ProjectState {
  return {
    ...state,
    ruleSets: state.ruleSets.map(normalizeRuleSet),
    lines: state.lines.map(normalizeLine),
    issues: state.issues ?? [],
    versions: state.versions ?? [],
  };
}

export function outputText(state: ProjectState): string {
  return state.lines.map((line, index) => `${String(index + 1).padStart(3, '0')}  ${line.tokens.map((token) => token.braille).join('')}`).join('\n');
}

export function brailleCellCount(state: ProjectState): number {
  return state.lines.reduce((total, line) => total + line.tokens.reduce((count, token) => count + token.braille.replace(/\s/g, '').length, 0), 0);
}
