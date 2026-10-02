import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { analyzeProject, brailleCellCount, outputText } from './braille';
import {
  addSpecEntry,
  deleteSpecEntry,
  editSpecEntry,
  mergeSpecEntries,
  reconcileProject,
  refreshRuleSetCache,
  updateSpecProfile,
} from './spec';
import { saveDraft, saveSpec, storageAvailable, type SaveState } from './storage';
import { bootstrapWorkspace } from './workspace';
import type { HistoryState, ProofIssue, ProjectState, SpecEntry, SpecTable, TextbookLine, VersionSnapshot } from './types';

const HISTORY_LIMIT = 60;
const RETRY_BASE_MS = 1200;
const RETRY_MAX_MS = 30_000;

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

interface DraftPersistence {
  saveState: SaveState;
  lastError: string;
  retryNow: () => void;
}

/**
 * 课文稿（学校侧）持久化：
 * 保存失败不丢编辑——保留上一版（storage 层已先写 .backup），按学校这侧重试，
 * 浏览器恢复在线后自动再存一次。
 */
function useDraftPersistence(state: ProjectState): DraftPersistence {
  const [saveState, setSaveState] = useState<SaveState>(storageAvailable() ? 'idle' : 'error');
  const [lastError, setLastError] = useState(storageAvailable() ? '' : '本地存储不可用，改动只保留在本次会话');
  const stateRef = useRef(state);
  stateRef.current = state;
  const retryTimer = useRef<number | undefined>(undefined);
  const attemptRef = useRef(0);
  const firstRun = useRef(true);

  const attemptSave = (): boolean => {
    try {
      saveDraft(stateRef.current);
      setSaveState('saved');
      setLastError('');
      attemptRef.current = 0;
      return true;
    } catch (error) {
      setSaveState('error');
      setLastError((error as Error).message);
      return false;
    }
  };

  const scheduleRetry = () => {
    if (retryTimer.current !== undefined) return;
    attemptRef.current += 1;
    const delay = Math.min(RETRY_BASE_MS * 2 ** (attemptRef.current - 1), RETRY_MAX_MS);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = undefined;
      if (attemptSave()) return;
      scheduleRetry();
    }, delay);
  };

  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    setSaveState('saving');
    if (attemptSave()) return;
    scheduleRetry();
  }, [state]);

  useEffect(() => {
    const flush = () => {
      if (saveState === 'error') {
        attemptRef.current = 0;
        if (retryTimer.current !== undefined) {
          clearTimeout(retryTimer.current);
          retryTimer.current = undefined;
        }
        if (!attemptSave()) scheduleRetry();
      }
    };
    window.addEventListener('online', flush);
    return () => window.removeEventListener('online', flush);
  }, [saveState]);

  useEffect(() => () => {
    if (retryTimer.current !== undefined) clearTimeout(retryTimer.current);
  }, []);

  return {
    saveState,
    lastError,
    retryNow: () => {
      attemptRef.current = 0;
      if (retryTimer.current !== undefined) {
        clearTimeout(retryTimer.current);
        retryTimer.current = undefined;
      }
      if (!attemptSave()) scheduleRetry();
    },
  };
}

function useProject(initial: ProjectState) {
  const [history, dispatch] = useReducer(historyReducer, undefined, () => ({
    past: [],
    present: initial,
    future: [],
    lastAction: '已恢复本地草稿',
  }));

  const commit = (label: string, update: (state: ProjectState) => ProjectState) => dispatch({ type: 'commit', label, update });
  const undo = () => dispatch({ type: 'undo' });
  const redo = () => dispatch({ type: 'redo' });
  const restore = (state: ProjectState) => dispatch({ type: 'restore', label: '恢复版本', state });

  return { state: history.present, history, commit, undo, redo, restore };
}

/** 保存教研组规范表：失败时上一版已由 storage 层保留，界面提示稍后重试 */
function persistSpec(spec: SpecTable): boolean {
  try {
    saveSpec(spec);
    return true;
  } catch {
    return false;
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

function issueLabel(issue: ProofIssue): string {
  if (issue.severity === 'error') return '阻断';
  if (issue.severity === 'warning') return '可疑';
  return '建议';
}

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
  specReadable,
  onSelect,
  onUpdateEntry,
  onToggleContractions,
  onAddEntry,
  onRecheck,
}: {
  state: ProjectState;
  specReadable: boolean;
  onSelect: (id: string) => void;
  onUpdateEntry: (entryId: string, patch: Record<string, unknown>) => void;
  onToggleContractions: () => void;
  onAddEntry: (source: string, output: string, suspicious: boolean) => void;
  onRecheck: () => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const [showAllRules, setShowAllRules] = useState(false);
  const [newSource, setNewSource] = useState('');
  const [newOutput, setNewOutput] = useState('');
  const [suspicious, setSuspicious] = useState(true);
  const visibleRules = showAllRules ? active.rules : active.rules.filter((rule) => rule.kind === 'contraction' || rule.suspicious);
  const readonlyTitle = specReadable ? undefined : '规范表暂时读不出来：课文稿可照常修改，规范条目已锁定只读';

  return (
    <aside class="left-panel scroll-pane" aria-label="规范表与条目编辑">
      {!specReadable && (
        <div class="spec-warning" role="status">
          <strong>规范表读不出来</strong>
          <span>课文稿可照常编辑保存；规范条目暂时锁定，恢复后再按教研组规范对账。</span>
        </div>
      )}
      <Section title="规则集" subtitle="切换后会自动重转录全部行">
        <div class="stack-sm">
          {state.ruleSets.map((ruleSet) => (
            <button class={`rule-set-card ${ruleSet.id === active.id ? 'active' : ''}`} key={ruleSet.id} onClick={() => onSelect(ruleSet.id)}>
              <span>
                <strong>{ruleSet.name}</strong>
                <small>{ruleSet.rules.filter((rule) => rule.enabled).length} 条启用条目</small>
              </span>
              <span class="radio-dot" aria-hidden="true" />
            </button>
          ))}
        </div>
      </Section>

      <Section
        title="教研组规范条目"
        subtitle={specReadable ? active.description : `${active.description}（规范表离线，只读）`}
        action={<md-text-button onClick={onRecheck}>重新检查</md-text-button>}
      >
        <div class="inline-controls">
          <md-checkbox checked={active.contractions} disabled={!specReadable} onInput={onToggleContractions} label="启用缩写" />
          <md-filled-tonal-button onClick={() => setShowAllRules((value) => !value)}>
            {showAllRules ? '只看常用条目' : '查看全部条目'}
          </md-filled-tonal-button>
        </div>
      </Section>

      <Section title="缩写与标点（教研组维护）" subtitle="换名或改动会留痕；引用它的已批准行结果变了会退回待核对">
        <div class="rule-list">
          {visibleRules.map((rule) => (
            <div class={`rule-row ${rule.suspicious ? 'suspicious' : ''}`} key={rule.id} title={readonlyTitle}>
              <md-checkbox checked={rule.enabled} disabled={!specReadable} onInput={() => onUpdateEntry(rule.specEntryId ?? rule.id, { enabled: !rule.enabled })} aria-label={`启用 ${rule.source}`} />
              <md-outlined-text-field
                class="rule-source"
                value={rule.source}
                label="原文"
                disabled={!specReadable}
                onChange={(event: any) => {
                  const value = event.currentTarget.value.trim();
                  if (value && value !== rule.source) onUpdateEntry(rule.specEntryId ?? rule.id, { source: value });
                }}
              />
              <md-outlined-text-field
                class="rule-output"
                value={rule.output}
                label="盲文"
                disabled={!specReadable}
                onChange={(event: any) => {
                  const value = event.currentTarget.value.trim();
                  if (value && value !== rule.output) onUpdateEntry(rule.specEntryId ?? rule.id, { output: value });
                }}
              />
              <md-icon-button
                class={rule.suspicious ? 'warning-button active' : 'warning-button'}
                disabled={!specReadable}
                aria-label={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                title={rule.suspicious ? '取消可疑标记' : '标记为可疑'}
                onClick={() => onUpdateEntry(rule.specEntryId ?? rule.id, { suspicious: !rule.suspicious })}
              >
                {rule.suspicious ? '!' : '○'}
              </md-icon-button>
            </div>
          ))}
        </div>
      </Section>

      <Section title="新增规范条目" subtitle="教研组发布；新增后引用范围的行将参与对账">
        <div class="stack-sm">
          <md-outlined-text-field value={newSource} label="原文或组合" disabled={!specReadable} onInput={(event: any) => setNewSource(event.currentTarget.value)} />
          <md-outlined-text-field value={newOutput} label="盲文单元" disabled={!specReadable} onInput={(event: any) => setNewOutput(event.currentTarget.value)} />
          <md-checkbox checked={suspicious} disabled={!specReadable} onInput={() => setSuspicious((value) => !value)} label="标记为可疑条目" />
          <md-filled-button
            disabled={!specReadable || !newSource.trim() || !newOutput.trim()}
            onClick={() => {
              onAddEntry(newSource.trim(), newOutput.trim(), suspicious);
              setNewSource('');
              setNewOutput('');
            }}
          >
            添加并重算
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
        <span class={`line-status ${line.status}`} title={`状态：${line.status}`} />
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
          <span class="eyebrow">逐行校对</span>
          <h1>{state.title}</h1>
          <p>{state.author} · {state.lines.length} 行 · {brailleCellCount(state)} 格</p>
        </div>
        <div class="toolbar-actions">
          <md-outlined-button onClick={() => setShowImport((value) => !value)}>导入课文</md-outlined-button>
          <md-outlined-button onClick={onSplitLongLines}>按句拆分</md-outlined-button>
          <md-filled-button onClick={onAddLine}>新增行</md-filled-button>
        </div>
      </div>

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
                <md-filled-tonal-button onClick={() => onBatchFix(group[0].ruleId!)}>停用规则并修正同类</md-filled-tonal-button>
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
  spec,
  specReadable,
  onUpdateEntry,
  onMergeEntry,
  onDeleteEntry,
}: {
  state: ProjectState;
  spec: SpecTable;
  specReadable: boolean;
  onUpdateEntry: (entryId: string, patch: Record<string, unknown>) => void;
  onMergeEntry: (fromId: string, intoId: string) => void;
  onDeleteEntry: (entryId: string) => void;
}) {
  const active = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const liveEntries = spec.entries.filter((entry) => !entry.tombstoned);
  const [mergeSource, setMergeSource] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');

  return (
    <div class="inspector-body">
      <div class="rule-summary">
        <strong>{active.name}</strong>
        <p>{active.description}</p>
        <div class="metric-row">
          <span>{active.rules.filter((rule) => rule.enabled).length} 条启用</span>
          <span>{active.rules.filter((rule) => rule.suspicious).length} 条可疑</span>
          <span>规范修订 r{spec.revision} / 稿 r{state.specRevision}</span>
        </div>
      </div>

      <Section title="两条并成一条" subtitle="被并条目立墓碑、旧名保留；引用它的行下次打开跟着重转">
        <div class="stack-sm">
          <select class="merge-select" value={mergeSource} disabled={!specReadable} onChange={(event: any) => setMergeSource(event.currentTarget.value)}>
            <option value="">选择被并条目…</option>
            {liveEntries.map((entry) => <option key={entry.id} value={entry.id}>{entry.source} → {entry.output}</option>)}
          </select>
          <select class="merge-select" value={mergeTarget} disabled={!specReadable} onChange={(event: any) => setMergeTarget(event.currentTarget.value)}>
            <option value="">并入哪一条…</option>
            {liveEntries.filter((entry) => entry.id !== mergeSource).map((entry) => <option key={entry.id} value={entry.id}>{entry.source} → {entry.output}</option>)}
          </select>
          <md-filled-tonal-button
            disabled={!specReadable || !mergeSource || !mergeTarget}
            onClick={() => {
              onMergeEntry(mergeSource, mergeTarget);
              setMergeSource('');
              setMergeTarget('');
            }}
          >
            合并条目并重算
          </md-filled-tonal-button>
        </div>
      </Section>

      {active.rules.map((rule) => {
        const entry = spec.entries.find((item) => item.id === (rule.specEntryId ?? rule.id));
        const mergedFrom = entry?.tombstoned ? entry.mergedInto : undefined;
        return (
          <div class={`rule-detail-card ${entry?.tombstoned ? 'tombstoned' : ''}`} key={rule.id}>
            <div>
              <strong>{rule.source || '数字符'}</strong>
              <span>{rule.output} · {rule.kind}</span>
              {rule.description && <p>{rule.description}</p>}
              <p class="attribution-line">
                {rule.specEntryId ? `归属规范条目 ${rule.specEntryId}` : '学校自定义 · 未归属'}
                {entry?.aliases.length ? ` ｜ 曾用名：${entry.aliases.join('、')}` : ''}
                {mergedFrom ? ` ｜ 已并入 ${mergedFrom}` : ''}
              </p>
            </div>
            <div class="rule-detail-actions">
              <md-checkbox checked={rule.suspicious} disabled={!specReadable} onInput={() => onUpdateEntry(rule.specEntryId ?? rule.id, { suspicious: !rule.suspicious })} label="可疑" />
              <md-icon-button aria-label="删除条目" title="删除规范条目" disabled={!specReadable} onClick={() => onDeleteEntry(rule.specEntryId ?? rule.id)}>×</md-icon-button>
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
        <div><strong>本地版本记录</strong><p>保存当前规则、原文、状态和备注的完整快照。</p></div>
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
  const [bootstrap] = useState(() => bootstrapWorkspace());
  const { state, history, commit, undo, redo, restore } = useProject(bootstrap.project);
  const draftPersistence = useDraftPersistence(state);
  const [spec, setSpec] = useState<SpecTable>(bootstrap.spec);
  const [specSaveError, setSpecSaveError] = useState(bootstrap.specReadable ? '' : bootstrap.specLoadError ?? '规范表读不出来');
  const [openNotice, setOpenNotice] = useState<{ kind: 'upgrade' | 'reconcile'; count: number } | null>(() => {
    if (bootstrap.upgradedFromRevision) return { kind: 'upgrade', count: bootstrap.revertedLineIds.length };
    if (bootstrap.revertedLineIds.length > 0) return { kind: 'reconcile', count: bootstrap.revertedLineIds.length };
    return null;
  });
  const specRef = useRef(spec);
  specRef.current = spec;
  const specReadable = bootstrap.specReadable;

  const [inspectorTab, setInspectorTab] = useState<'issues' | 'rules' | 'versions'>('issues');
  const selectedLineRef = useRef(state.selectedLineId);
  selectedLineRef.current = state.selectedLineId;

  const activeRuleSet = state.ruleSets.find((ruleSet) => ruleSet.id === state.activeRuleSetId) ?? state.ruleSets[0];
  const unresolvedCount = state.issues.filter((issue) => !issue.resolved).length;
  const approvedCount = state.lines.filter((line) => line.status === 'approved').length;
  const progress = state.lines.length ? Math.round((approvedCount / state.lines.length) * 100) : 0;

  /**
   * 教研组改规范条目的统一入口：
   * 规范表（教研组侧）先落盘并留痕，再刷新课文稿缓存并按变更对账，
   * 用过该条目的行重算，已批准且结果变化的行退回待核对。
   */
  const applySpecChange = (label: string, mutate: (current: SpecTable) => SpecTable) => {
    if (!specReadable) return;
    const nextSpec = mutate(specRef.current);
    if (nextSpec === specRef.current) return;
    const ok = persistSpec(nextSpec);
    setSpecSaveError(ok ? '' : '规范表保存失败：已保留上一版，请稍后重试；本次改动先在本会话生效。');
    setSpec(nextSpec);
    commit(label, (current) => {
      const refreshed = refreshRuleSetCache(current, nextSpec);
      return reconcileProject(refreshed, nextSpec, refreshed.ruleSets).project;
    });
  };

  const updateEntry = (entryId: string, patch: Record<string, unknown>) => {
    applySpecChange('教研组修订规范条目', (current) =>
      editSpecEntry(current, entryId, patch as Partial<SpecEntry>),
    );
  };

  const addEntry = (sourceValue: string, output: string, suspicious: boolean) => {
    applySpecChange('教研组新增规范条目', (current) =>
      addSpecEntry(current, {
        id: `entry-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
        source: sourceValue,
        output,
        kind: 'contraction',
        enabled: true,
        suspicious,
        description: '教研组新增条目',
      }),
    );
  };

  const mergeEntries = (fromId: string, intoId: string) => {
    applySpecChange('教研组合并规范条目', (current) => mergeSpecEntries(current, fromId, intoId));
  };

  const deleteEntry = (entryId: string) => {
    applySpecChange('教研组删除规范条目', (current) => deleteSpecEntry(current, entryId));
  };

  const selectLine = (lineId: string, scroll = false) => {
    commit('切换当前行', (current) => ({ ...current, selectedLineId: lineId }));
    if (scroll) requestAnimationFrame(() => document.querySelector(`#line-card-${lineId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  };

  const changeLine = (lineId: string, source: string) => {
    commit('修改课文原文', (current) => analyzeProject({
      ...current,
      // 原文被改动的已批准/已校对行需要重新走一遍校对（与规范变动退回相区别，这里直接置为未核）
      lines: current.lines.map((line) => {
        if (line.id !== lineId || line.source === source) return line;
        const needsReproof = line.status === 'approved' || line.status === 'reviewed';
        return { ...line, source, status: needsReproof ? 'unchecked' : line.status };
      }),
    }));
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
      const editing = /INPUT|TEXTAREA|SELECT/.test(target.tagName) || target.isContentEditable;
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
    const blob = new Blob([`${state.title}\n规则集：${activeRuleSet.name}\n规范修订：r${spec.revision}\n\n${outputText(state)}\n`], { type: 'text/plain;charset=utf-8' });
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
    printWindow.document.write(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${state.title}</title><style>body{font-family:Georgia,serif;color:#111;margin:36px}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:10px;border-bottom:1px solid #bbb;text-align:left;vertical-align:top}td:first-child{width:36px;color:#666}.braille{font-family:"Apple Braille",sans-serif;font-size:24px}@media print{body{margin:16mm}}</style></head><body><h1>${state.title}</h1><p>${state.author} · ${activeRuleSet.name} · r${spec.revision} · ${new Date().toLocaleDateString('zh-CN')}</p><table><thead><tr><th>#</th><th>原文</th><th>盲文校对稿</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>setTimeout(()=>window.print(),150)</script></body></html>`);
    printWindow.document.close();
  };

  /** 问题面板的"停用规则并修正同类"现在停用规范条目（教研组动作） */
  const batchDisableEntry = (entryId: string) => {
    applySpecChange('停用规范条目并修正同类', (current) => editSpecEntry(current, entryId, { enabled: false }));
  };

  const importCourse = (text: string) => {
    const sourceLines = text
      .replace(/\r/g, '')
      .split(/\n+|(?<=[.!?。！？])\s+/)
      .map((line) => line.trim())
      .filter(Boolean);
    commit('导入课文', (current) => analyzeProject({
      ...current,
      lines: sourceLines.map((source, index) => ({ id: `line-import-${Date.now()}-${index}`, source, tokens: [], status: index === 0 ? 'questionable' : 'unchecked', note: index === 0 ? '导入后待确认规则集。' : '', continuesPrevious: false, continuesNext: false })),
      selectedLineId: '',
      issues: [],
    }));
  };

  const saveStateLabel = {
    idle: '',
    saving: '正在保存…',
    saved: '学校稿已保存',
    error: '保存失败 · 上一版已保留',
  }[draftPersistence.saveState];

  return (
    <div class="app-shell">
      {openNotice && (
        <div class={`open-notice ${openNotice.kind}`} role="status">
          <span>
            {openNotice.kind === 'upgrade'
              ? `旧稿已按教研组规范表升级：补全条目归属并兼容原校对备注；${openNotice.count} 行批准结果发生变化，已退回待核对。`
              : `规范表有新条目变动：受影响行已重算，${openNotice.count} 行批准结果变化，已退回待核对，备注中写明了变动条目。`}
          </span>
          <md-text-button onClick={() => setOpenNotice(null)}>知道了</md-text-button>
        </div>
      )}
      <header class="topbar">
        <div class="brand">
          <div class="brand-mark" aria-hidden="true">⠿</div>
          <div><strong>BrailleAtelier</strong><span>盲文教材转录与校对工具 · 规范表归教研组 / 课文稿归学校</span></div>
        </div>
        <div class="topbar-center">
          <span class={`connection-dot ${specReadable ? 'online' : ''}`} />
          {specReadable ? `规范表 r${spec.revision} · 课文稿 r${state.specRevision}` : '规范表离线 · 课文稿照常编辑'}
          <small title={draftPersistence.lastError || specSaveError}>
            {draftPersistence.saveState === 'error'
              ? saveStateLabel
              : `${saveStateLabel || '本地保存'} · 上次自动保存 ${formatTime(state.updatedAt)}`}
          </small>
          {draftPersistence.saveState === 'error' && (
            <md-text-button onClick={draftPersistence.retryNow}>重试保存</md-text-button>
          )}
        </div>
        <div class="topbar-actions">
          <md-icon-button onClick={undo} disabled={history.past.length === 0} aria-label="撤销" title="撤销 ⌘Z">↶</md-icon-button>
          <md-icon-button onClick={redo} disabled={history.future.length === 0} aria-label="重做" title="重做 ⇧⌘Z">↷</md-icon-button>
          <md-outlined-button onClick={exportText}>导出文本</md-outlined-button>
          <md-filled-button onClick={exportPrint}>打印版导出</md-filled-button>
        </div>
      </header>

      {(draftPersistence.lastError || specSaveError) && (
        <div class="save-error-banner" role="alert">
          {draftPersistence.lastError && <span>课文稿：{draftPersistence.lastError} 改动不会丢，会自动重试。</span>}
          {specSaveError && <span>规范表：{specSaveError}</span>}
        </div>
      )}

      <div class="status-ribbon">
        <div class="progress-block">
          <div><strong>{progress}%</strong><span>已批准 {approvedCount}/{state.lines.length} 行</span></div>
          <md-linear-progress value={progress / 100} aria-label="校对进度" />
        </div>
        <div class="status-stat warning"><strong>{unresolvedCount}</strong><span>未处理问题</span></div>
        <div class="status-stat"><strong>{state.lines.filter((line) => line.status === 'questionable').length}</strong><span>待核对行</span></div>
        <div class="status-stat"><strong>{activeRuleSet.rules.filter((rule) => rule.enabled).length}</strong><span>启用规范条目</span></div>
        <div class="shortcut-hint">快捷键：⌘/Ctrl Z 撤销 · ⇧⌘/Ctrl Z 重做 · ⌘/Ctrl Enter 批准并下一行 · J/K 切换行</div>
      </div>

      <div class="workspace-grid">
        <RuleSetPanel
          state={state}
          specReadable={specReadable}
          onSelect={(id) => commit('切换规则集并重新检查', (current) => analyzeProject({ ...current, activeRuleSetId: id, issues: [] }))}
          onUpdateEntry={updateEntry}
          onToggleContractions={() => {
            const ruleSetId = activeRuleSet.id;
            applySpecChange('规则集切换缩写开关', (current) => {
              const profile = current.profiles.find((item) => item.id === ruleSetId);
              return profile ? updateSpecProfile(current, ruleSetId, { contractions: !profile.contractions }) : current;
            });
          }}
          onAddEntry={addEntry}
          onRecheck={() => commit('重新检查全部内容', analyzeProject)}
        />

        <EditorPanel
          state={state}
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
            <button class={inspectorTab === 'rules' ? 'active' : ''} onClick={() => setInspectorTab('rules')}>规范条目</button>
            <button class={inspectorTab === 'versions' ? 'active' : ''} onClick={() => setInspectorTab('versions')}>版本 {state.versions.length > 0 && <span>{state.versions.length}</span>}</button>
          </div>
          {inspectorTab === 'issues' && (
            <IssuesPanel
              issues={state.issues}
              lines={state.lines}
              onJump={(lineId) => selectLine(lineId, true)}
              onResolve={(issueId) => commit('标记问题已处理', (current) => ({ ...current, issues: current.issues.map((item) => item.id === issueId ? { ...item, resolved: true } : item) }))}
              onBatchFix={batchDisableEntry}
            />
          )}
          {inspectorTab === 'rules' && (
            <RuleDetailPanel
              state={state}
              spec={spec}
              specReadable={specReadable}
              onUpdateEntry={updateEntry}
              onMergeEntry={mergeEntries}
              onDeleteEntry={deleteEntry}
            />
          )}
          {inspectorTab === 'versions' && <VersionsPanel state={state} onSnapshot={() => recordVersion()} onRestore={(version) => {
            const restored: ProjectState = cloneState({ ...version.snapshot, versions: state.versions });
            // 恢复旧版本后同样按当前规范表对账：已批准结果落后于规范就退回
            const refreshed = specReadable ? refreshRuleSetCache(restored, specRef.current) : restored;
            const reconciled = specReadable ? reconcileProject(refreshed, specRef.current, refreshed.ruleSets).project : restored;
            restore(reconciled);
          }} />}
        </aside>
      </div>
    </div>
  );
}
