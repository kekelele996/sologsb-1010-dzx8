import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import {
  analyzeProject,
  brailleCellCount,
  detectRuleChanges,
  diffRuleSets,
  makeRule,
  mergeRules,
  normalizeProject,
  outputText,
  updateRuleInSet,
} from './braille';
import { bootProject } from './boot';
import type { BootResult } from './boot';
import { toDraftDoc, writeDraft, writeStandards } from './storage';
import type {
  HistoryState,
  LineStatus,
  ProofIssue,
  ProjectState,
  RuleChange,
  RuleSet,
  TextbookLine,
  TranscriptionRule,
  VersionSnapshot,
} from './types';

const HISTORY_LIMIT = 60;
const SAVE_RETRY_LIMIT = 3;

type HistoryAction =
  | { type: 'commit'; label: string; update: (state: ProjectState) => ProjectState }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'restore'; label: string; state: ProjectState };

function cloneState(state: ProjectState): ProjectState {
  return structuredClone(state);
}

function historyReducer(state: HistoryState, action: HistoryAction): HistoryState {
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future].slice(0, HISTORY_LIMIT),
      lastAction: '撤销',
    };
  }

  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return {
      past: [...state.past, state.present].slice(-HISTORY_LIMIT),
      present: next,
      future: state.future.slice(1),
      lastAction: '重做',
    };
  }

  const next = action.type === 'restore' ? cloneState(action.state) : action.update(cloneState(state.present));
  if (next === state.present) return state;
  return {
    past: [...state.past, state.present].slice(-HISTORY_LIMIT),
    present: next,
    future: [],
    lastAction: action.label,
  };
}

type SavePhase = 'saved' | 'retrying' | 'failed';

function useProject(boot: BootResult) {
  const [history, dispatch] = useReducer(historyReducer, boot.project, (project) => ({
    past: [],
    present: project,
    future: [],
    lastAction: boot.notice,
  }));
  const [draftSave, setDraftSave] = useState<SavePhase>('saved');
  const [standardsSaveFailed, setStandardsSaveFailed] = useState(false);
  const [saveNonce, setSaveNonce] = useState(0);
  const standardsJsonRef = useRef('');
  const draftJsonRef = useRef('');
  const retryTimerRef = useRef<number | undefined>(undefined);

  // 规范表（教研组）独立保存；读取失败降级期间不覆盖教研组数据。
  useEffect(() => {
    if (boot.standardsDegraded) return;
    const json = JSON.stringify(history.present.ruleSets);
    if (json === standardsJsonRef.current) return;
    standardsJsonRef.current = json;
    try {
      writeStandards(history.present.ruleSets);
      setStandardsSaveFailed(false);
    } catch {
      setStandardsSaveFailed(true);
    }
  }, [history.present.ruleSets, boot.standardsDegraded]);

  // 课文稿（学校）独立保存；失败按学校这侧重试，上一版先留着。
  useEffect(() => {
    const doc = toDraftDoc(history.present);
    const json = JSON.stringify(doc);
    if (json === draftJsonRef.current) return;
    draftJsonRef.current = json;
    let cancelled = false;
    let attempts = 0;
    const attempt = () => {
      try {
        writeDraft(doc);
        if (!cancelled) setDraftSave('saved');
      } catch {
        if (cancelled) return;
        attempts += 1;
        if (attempts <= SAVE_RETRY_LIMIT) {
          setDraftSave('retrying');
          retryTimerRef.current = window.setTimeout(attempt, 1200 * attempts);
        } else {
          // 自动重试仍失败：上一版仍在本地，等待手动重试。
          setDraftSave('failed');
        }
      }
    };
    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimerRef.current);
    };
  }, [history.present, saveNonce]);

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });
  const retrySave = () => {
    draftJsonRef.current = '';
    setDraftSave('retrying');
    setSaveNonce((nonce) => nonce + 1);
  };

  return { state: history.present, history, commit, undo, redo, restore, draftSave, standardsSaveFailed, retrySave };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

const STATUS_LABELS: Record<LineStatus, string> = {
  unchecked: '未校对',
  reviewed: '已校对',
  questionable: '待核对',
  approved: '已批准',
};

function Section({ title, subtitle, action, children }: { title: string; subtitle?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="panel-section">
      <div class="section-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function RuleSetPanel({
  state,
  onSelect,
  onUpdateRule,
  onToggleContractions,
  onAddRule,
  onRecheck,
}: {
  state: ProjectState;
  onSelect: (id: string) => void;
  onUpdateRule: (ruleId: string, patch: Partial<TranscriptionRule>) => void;
  onToggleContractions: () => void;
  onAddRule: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);

  return (
    <aside class="left-panel scroll-pane" aria-label="规范表与条目编辑">
      <Section title="规范表" subtitle="规范表由教研组维护，学校侧选择使用；条目改动后引用它的课文行会自动重算">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>
                  {ruleSet.rules.filter((rule) => rule.enabled).length} 条启用条目
                  {ruleSet.updatedAt ? ` · ${formatTime(ruleSet.updatedAt)}更新` : ''}
                </small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="当前条目"
        subtitle={active.description}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用条目' : '查看全部条目'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点" subtitle="可疑条目会在校对区生成提醒；改动条目即升版本">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id}>
              <md-checkbox checked={rule.enabled} onInput={() => onUpdateRule(rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                onInput={(event: any) => onUpdateRule(rule.id, { source: event.currentTarget.value })}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                onInput={(event: any) => onUpdateRule(rule.id, { output: event.currentTarget.value })}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增条目" subtitle="可添加缩写、字母组合或自定义符号">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} onInput={() => setSuspicious((value) => !value)} label="标记为可疑条目" />
          <md-filled-button
            disabled={!newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddRule(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并检查
          </md-filled-button>
        </div>
      </Section>
    </aside>
  );
}

function LineCard({
  line,
  index,
  selected,
  issues,
  onSelect,
  onChange,
  onNote,
  onStatus,
  onDelete,
}: {
  line: TextbookLine;
  index: number;
  selected: boolean;
  issues: ProofIssue[];
  onSelect: () => void;
  onChange: (source: string) => void;
  onNote: (note: string) => void;
  onStatus: (status: TextbookLine['status']) => void;
  onDelete: () => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const lineIssues = unresolved.filter((issue) => issue.lineId === line.id);

  return (
    <article class={`line-card ${selected ? 'selected' : ''}`} id={`line-card-${line.id}`} onClick={onSelect}>
      <div class="line-gutter">
        <span>{String(index + 1).padStart(2, '0')}</span>
        <span class={`line-status ${line.status}`} title={`状态：${STATUS_LABELS[line.status]}`} />
      </div>
      <div class="line-body">
        <div class="line-source">
          <textarea
            aria-label={`第 ${index + 1} 行原文`}
            value={line.source}
            rows={Math.max(1, Math.ceil(line.source.length / 52))}
            onFocus={onSelect}
            onInput={(event) => onChange((event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="line-actions">
            <md-icon-button aria-label="标记待核对" title="标记待核对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('questionable'); }}>?</md-icon-button>
            <md-icon-button aria-label="标记已校对" title="标记已校对" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('reviewed'); }}>✓</md-icon-button>
            <md-icon-button aria-label="批准此行" title="批准此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onStatus('approved'); }}>★</md-icon-button>
            <md-icon-button aria-label="删除此行" title="删除此行" onClick={(event: MouseEvent) => { event.stopPropagation(); onDelete(); }}>×</md-icon-button>
          </div>
        </div>
        <div class="braille-preview" aria-label={`第 ${index + 1} 行盲文预览`}>
          {line.tokens.length === 0 && <span class="empty-preview">空行</span>}
          {line.tokens.map((token) => (
            token.text === ' ' ? <span class="space-token" title="分词空格" /> : (
              <span
                class={`braille-token ${token.suspicious ? 'suspicious' : ''} ${token.braille.includes('⟦') ? 'error' : ''}`}
                title={`${token.text || '标记'} → ${token.braille}`}
              >
                <b>{token.text || '标记'}</b>
                <span>{token.braille}</span>
              </span>
            )
          ))}
        </div>
        {lineIssues.length > 0 && (
          <div class="line-warnings">
            {lineIssues.slice(0, 3).map((item) => (
              <span class={`issue-chip ${item.severity}`} key={item.id}>{issueLabel(item)} · {item.message}</span>
            ))}
          </div>
        )}
        {selected && (
          <md-outlined-text-field
            class="note-field"
            value={line.note}
            label="校对备注"
            onInput={(event: any) => onNote(event.currentTarget.value)}
          />
        )}
      </div>
    </article>
  );
}

function EditorPanel({
  state,
  standardsDegraded,
  ruleChangedCount,
  onShowIssues,
  onSelectLine,
  onChangeLine,
  onNote,
  onStatus,
  onDelete,
  onAddLine,
  onSplitLongLines,
  onImport,
}: {
  state: ProjectState;
  standardsDegraded: boolean;
  ruleChangedCount: number;
  onShowIssues: () => void;
  onSelectLine: (id: string) => void;
  onChangeLine: (id: string, source: string) => void;
  onNote: (id: string, note: string) => void;
  onStatus: (id: string, status: TextbookLine['status']) => void;
  onDelete: (id: string) => void;
  onAddLine: () => void;
  onSplitLongLines: () => void;
  onImport: (text: string) => void;
}) {
  const [showImport, setShowImport] = useState(false);
  const [importText, setImportText] = useState('');

  return (
    <main class="editor-panel" aria-label="逐行转录校对区">
      <div class="editor-toolbar">
        <div>
          <span class="eyebrow">逐行校对 · 课文稿归学校维护</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

      {standardsDegraded && (
        <div class="notice-strip warning" role="status">
          规范表暂时读取失败，已按内置规则继续；课文稿可照常编辑与保存，规范表恢复后会自动重新核对。
        </div>
      )}
      {ruleChangedCount > 0 && (
        <div class="notice-strip" role="status">
          <span>规范条目变更：{ruleChangedCount} 行已批准内容结果改变，已退回待核对，改动的条目已写入行备注。</span>
          <md-text-button onClick={onShowIssues}>查看问题</md-text-button>
        </div>
      )}

      {showImport && (
        <div class="import-strip">
          <md-outlined-text-field
            type="textarea"
            rows={5}
            value={importText}
            label="粘贴课文；换行或句末标点将被拆成行"
            onInput={(event: any) => setImportText(event.currentTarget.value)}
          />
          <div>
            <md-text-button onClick={() => { setImportText(''); setShowImport(false); }}>取消</md-text-button>
            <md-filled-button
              disabled={!importText.trim()}
              onClick={() => {
                onImport(importText);
                setImportText('');
                setShowImport(false);
              }}
            >
              替换并重新转录
            </md-filled-button>
          </div>
        </div>
      )}

      <div class="line-list scroll-pane">
        {state.lines.map((line, index) => (
          <LineCard
            key={line.id}
            line={line}
            index={index}
            selected={state.selectedLineId === line.id}
            issues={state.issues}
            onSelect={() => onSelectLine(line.id)}
            onChange={(source) => onChangeLine(line.id, source)}
            onNote={(note) => onNote(line.id, note)}
            onStatus={(status) => onStatus(line.id, status)}
            onDelete={() => onDelete(line.id)}
          />
        ))}
      </div>
    </main>
  );
}

function IssuesPanel({
  issues,
  lines,
  onJump,
  onResolve,
  onBatchFix,
}: {
  issues: ProofIssue[];
  lines: TextbookLine[];
  onJump: (lineId: string) => void;
  onResolve: (issueId: string) => void;
  onBatchFix: (ruleId: string) => void;
}) {
  const unresolved = issues.filter((issue) => !issue.resolved);
  const grouped = useMemo(() => {
    const map = new Map<string, ProofIssue[]>();
    unresolved.forEach((item) => {
      const key = item.ruleId ? `rule:${item.ruleId}` : `code:${item.code}`;
      map.set(key, [...(map.get(key) ?? []), item]);
    });
    return [...map.entries()];
  }, [unresolved]);

  return (
    <div class="inspector-body">
      {grouped.length === 0 && <div class="empty-state"><span>✓</span><strong>没有未处理问题</strong><p>可以记录版本或导出打印稿。</p></div>}
      {grouped.map(([key, group]) => {
        const lineNumbers = group.map((item) => lines.findIndex((line) => line.id === item.lineId) + 1).join('、');
        return (
          <div class="issue-group" key={key}>
            <div class="issue-group-head">
              <span class={`severity-dot ${group[0].severity}`} />
              <div>
                <strong>{group[0].message}</strong>
                <p>影响第 {lineNumbers} 行 · 共 {group.length} 处</p>
              </div>
            </div>
            <div class="issue-actions">
              <md-text-button onClick={() => onJump(group[0].lineId)}>定位首处</md-text-button>
              {group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用条目并修正同类</md-filled-tonal-button>
              )}
              {!group[0].ruleId && group.length > 1 && (
                <md-filled-tonal-button onClick={() => group.forEach((item) => onResolve(item.id))}>全部标记已处理</md-filled-tonal-button>
              )}
              <md-icon-button aria-label="标记此项已处理" title="标记已处理" onClick={() => onResolve(group[0].id)}>✓</md-icon-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RuleDetailPanel({
  state,
  onUpdateRule,
  onDeleteRule,
  onMergeRule,
}: {
  state: ProjectState;
  onUpdateRule: (id: string, patch: Partial<TranscriptionRule>) => void;
  onDeleteRule: (id: string) => void;
  onMergeRule: (sourceId: string, targetId: string) => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});

  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row">
          <span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span>
          <span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span>
          {active.updatedAt && <span>更新 {formatTime(active.updatedAt)}</span>}
        </div>
      </div>
      {active.rules.map((rule) => {
        const candidates = active.rules.filter((item) => item.id !== rule.id && item.kind === rule.kind);
        return (
          <div class="rule-detail-card" key={rule.id}>
            <div class="rule-detail-main">
              <div>
                <strong>{rule.source || '数字符'} <span class="rule-rev">v{rule.revision}</span></strong>
                <span>{rule.output} · {rule.kind}</span>
                {rule.aliases.length > 0 && <p>已并入 {rule.aliases.length} 条旧条目，引用它们的行下次打开会自动重转。</p>}
                {rule.description && <p>{rule.description}</p>}
              </div>
              <div class="rule-detail-actions">
                <md-checkbox checked={rule.suspicious} onInput={() => onUpdateRule(rule.id, { suspicious: !rule.suspicious })} label="可疑" />
                <md-icon-button aria-label="删除条目" title="删除条目" onClick={() => onDeleteRule(rule.id)}>×</md-icon-button>
              </div>
            </div>
            <div class="rule-merge-row">
              <select
                aria-label={`选择「${rule.source}」要并入的条目`}
                value={mergeTargets[rule.id] ?? ''}
                onChange={(event) => setMergeTargets((current) => ({ ...current, [rule.id]: (event.currentTarget as HTMLSelectElement).value }))}
              >
                <option value="">选择保留的条目…</option>
                {candidates.map((item) => <option value={item.id} key={item.id}>{item.source || item.description}</option>)}
              </select>
              <md-text-button
                disabled={!mergeTargets[rule.id]}
                onClick={() => {
                  onMergeRule(rule.id, mergeTargets[rule.id]);
                  setMergeTargets((current) => ({ ...current, [rule.id]: '' }));
                }}
              >
                并入所选条目
              </md-text-button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function VersionsPanel({ state, onSnapshot, onRestore }: { state: ProjectState; onSnapshot: () => void; onRestore: (version: VersionSnapshot) => void }) {
  return (
    <div class="inspector-body">
      <div class="snapshot-callout">
        <div><strong>本地版本记录</strong><p>保存当前原文、状态和备注的完整快照；恢复时按现行规范表重新核对。</p></div>
        <md-filled-button onClick={onSnapshot}>记录版本</md-filled-button>
      </div>
      {state.versions.length === 0 && <div class="empty-state compact"><strong>还没有版本快照</strong><p>完成一轮校对后记录版本，便于比较和恢复。</p></div>}
      <div class="timeline">
        {state.versions.map((version) => (
          <div class="timeline-item" key={version.id}>
            <span class="timeline-dot" />
            <div>
              <strong>{version.name}</strong>
              <p>{version.action} · {formatTime(version.createdAt)}</p>
              <div class="metric-row"><span>{version.snapshot.lines.length} 行</span><span>{version.snapshot.issues.filter((issue) => !issue.resolved).length} 个未处理问题</span></div>
              <md-text-button onClick={() => onRestore(version)}>恢复此版本</md-text-button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [boot] = useState(bootProject);
  const { state, history, commit, undo, redo, restore, draftSave, standardsSaveFailed, retrySave } = useProject(boot);
  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions'>('issues');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const ruleChangedCount = state.issues.filter((issue) => issue.code === 'rule-changed' && !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, source } : line) }));
  };

  const changeStatus = (lineId: string, status: TextbookLine['status']) => {
    commit('更新校对状态', (current) => {
      const lines = current.lines.map((line) => line.id === lineId ? { ...line, status } : line);
      const issues = current.issues.map((item) => item.lineId === lineId && status === 'approved' ? { ...item, resolved: true } : item);
      return { ...current, lines, issues, updatedAt: new Date().toISOString() };
    });
  };

  const navigateLine = (direction: number) => {
    const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
    const next = state.lines[Math.max(0, Math.min(state.lines.length - 1, index + direction))];
    if (next && next.id !== selectedLineRef.current) selectLine(next.id, true);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const editing = /INPUT|TEXTAREA/.test(target.tagName) || target.isContentEditable;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        recordVersion('快捷保存');
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        changeStatus(selectedLineRef.current, 'approved');
        const index = state.lines.findIndex((line) => line.id === selectedLineRef.current);
        if (state.lines[index + 1]) selectLine(state.lines[index + 1].id, true);
        return;
      }
      if (!editing && (event.key === 'ArrowDown' || event.key === 'j')) {
        event.preventDefault();
        navigateLine(1);
      }
      if (!editing && (event.key === 'ArrowUp' || event.key === 'k')) {
        event.preventDefault();
        navigateLine(-1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const createSnapshot = (action: string, source = state): VersionSnapshot => {
    const { versions: _versions, ...snapshot } = cloneState(source);
    return {
      id: `version-${Date.now().toString(36)}`,
      name: `${action} · ${source.lines.filter((line) => line.status === 'approved').length}/${source.lines.length} 行完成`,
      createdAt: new Date().toISOString(),
      action,
      snapshot,
    };
  };

  const recordVersion = (action = '手动记录') => {
    commit('记录版本快照', (current) => ({ ...current, versions: [createSnapshot(action, current), ...current.versions].slice(0, 20), updatedAt: new Date().toISOString() }));
  };

  const exportText = () => {
    const blob = new Blob([`${state.title}\n规范表：${activeRuleSet.name}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${state.title.replace(/[^\p{L}\p{N}-]+/gu, '-')}-盲文.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const exportPrint = () => {
    const printWindow = window.open('', '_blank', 'width=900,height=1100');
    if (!printWindow) return;
    const rows = state.lines.map((line, index) => `
      <tr><td>${index + 1}</td><td>${line.source.replace(/[<>&]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[char] ?? char))}</td><td class="braille">${line.tokens.map((token) => token.braille).join('')}</td></tr>
    `).join('');
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  /** 规范条目变更的统一入口：先改规范表，再带着变更清单重算引用行。 */
  const commitRuleSetChange = (label: string, transform: (ruleSet: RuleSet) => RuleSet, extraChanges: RuleChange[] = []) => {
    commit(label, (current) => {
      const ruleSet = current.ruleSets.find((set) => set.id === current.activeRuleSetId) ?? current.ruleSets[0];
      const nextSet = transform(ruleSet);
      const changes = [...diffRuleSets(ruleSet, nextSet), ...extraChanges];
      return analyzeProject({ ...current, ruleSets: current.ruleSets.map((set) => (set.id === nextSet.id ? nextSet : set)) }, { changes });
    });
  };

  const updateRule = (ruleId: string, patch: Partial<TranscriptionRule>) => {
    commitRuleSetChange('修改规范条目', (ruleSet) => updateRuleInSet(ruleSet, ruleId, patch));
  };

  const batchFixRule = (ruleId: string) => {
    commitRuleSetChange('批量修正同类问题', (ruleSet) => updateRuleInSet(ruleSet, ruleId, { enabled: false }));
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规范表。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  return (
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${boot.standardsDegraded || standardsSaveFailed ? 'error' : 'online'}`} />
          <span>规范表 · 教研组{boot.standardsDegraded ? '读取失败' : standardsSaveFailed ? '保存失败' : '已保存'}</span>
          <span class="topbar-divider" aria-hidden="true" />
          <span class={`connection-dot ${draftSave === 'saved' ? 'online' : draftSave === 'retrying' ? '' : 'error'}`} />
          <span>课文稿 · 学校{draftSave === 'saved' ? '已保存' : draftSave === 'retrying' ? '保存失败，重试中…' : '保存失败，上一版已保留'}</span>
          {draftSave === 'failed' && <button class="retry-save" onClick={retrySave}>按学校侧重试</button>}
          <small>上次检查 {formatTime(state.lastCheckedAt)}</small>
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用条目</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          onSelect={(id) => commit('切换规范表并重新检查', (current) => {
            const nextSet = current.ruleSets.find((ruleSet) => ruleSet.id === id) ?? current.ruleSets[0];
            const changes: RuleChange[] = [{ ruleId: '__ruleset__', kind: 'switched', label: nextSet.name, detail: `规范表已切换为「${nextSet.name}」` }];
            return analyzeProject({ ...current, activeRuleSetId: nextSet.id, issues: [] }, { changes });
          })}
          onUpdateRule={updateRule}
          onToggleContractions={() => commitRuleSetChange('切换缩写规则', (ruleSet) => ({ ...ruleSet, contractions: !ruleSet.contractions, updatedAt: new Date().toISOString() }), [{ ruleId: '__contractions__', kind: 'edited', label: '缩写开关', detail: '规范表缩写开关已切换' }])}
          onAddRule={(source, output, suspicious) => commitRuleSetChange('新增规范条目', (ruleSet) => ({ ...ruleSet, updatedAt: new Date().toISOString(), rules: [...ruleSet.rules, makeRule(source, output, suspicious)] }))}
          onRecheck={() => commit('重新检查全部内容', (current) => analyzeProject(current))}
        />

        <EditorPanel
          state={state}
          standardsDegraded={boot.standardsDegraded}
          ruleChangedCount={ruleChangedCount}
          onShowIssues={() => setInspectorTab('issues')}
          onSelectLine={selectLine}
          onChangeLine={changeLine}
          onNote={(lineId, note) => commit('添加校对备注', (current) => ({ ...current, lines: current.lines.map((line) => line.id === lineId ? { ...line, note } : line) }))}
          onStatus={changeStatus}
          onDelete={(lineId) => commit('删除课文行', (current) => {
            const lines = current.lines.filter((line) => line.id !== lineId);
            return analyzeProject({ ...current, lines: lines.length ? lines : [{ id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }], selectedLineId: lines[0]?.id ?? '' });
          })}
          onAddLine={() => commit('新增课文行', (current) => {
            const line: TextbookLine = { id: `line-${Date.now()}`, source: '', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false };
            return analyzeProject({ ...current, lines: [...current.lines, line], selectedLineId: line.id });
          })}
          onSplitLongLines={() => commit('按句拆分长行', (current) => {
            const lines = current.lines.flatMap((line) => line.source
              .split(/(?<=[.!?。！？])\s+|;\s*/)
              .filter((part) => part.trim())
              .map((source, index) => ({ ...line, id: index === 0 ? line.id : `line-split-${Date.now()}-${index}`, source: source.trim(), tokens: [], note: index === 0 ? line.note : '' })));
            return analyzeProject({ ...current, lines });
          })}
          onImport={importCourse}
        />

        <aside class="right-panel">
          <div class="inspector-tabs" role="tablist">
            <button class={inspectorTab === 'issues' ? 'active' : ''} onClick={() => setInspectorTab('issues')}>问题 {unresolvedCount > 0 && <span>{unresolvedCount}</span>}</button>
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>条目详情</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchFixRule}
            />
          )}
          {inspectorTab === 'rules' && (
            <RuleDetailPanel
              state={state}
              onUpdateRule={updateRule}
              onDeleteRule={(ruleId) => commitRuleSetChange('删除规范条目', (ruleSet) => ({ ...ruleSet, updatedAt: new Date().toISOString(), rules: ruleSet.rules.filter((rule) => rule.id !== ruleId) }))}
              onMergeRule={(sourceId, targetId) => commitRuleSetChange('合并规范条目', (ruleSet) => mergeRules(ruleSet, sourceId, targetId))}
            />
          )}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            // 恢复学校侧的课文稿；规范表保持教研组现行版本，恢复后按它重新核对。
            const draftSlice = toDraftDoc({ ...version.snapshot, versions: state.versions });
            const restored = normalizeProject({ ...draftSlice, ruleSets: state.ruleSets });
            const activeSet = restored.ruleSets.find((ruleSet) => ruleSet.id === restored.activeRuleSetId) ?? restored.ruleSets[0];
            restore(analyzeProject({ ...restored, activeRuleSetId: activeSet.id }, { changes: detectRuleChanges(restored.lines, activeSet) }));
          }} />}
        </aside>
      </div>
    </div>
  );
}
