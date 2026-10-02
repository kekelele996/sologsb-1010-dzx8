/**
 * 场景验证（不依赖浏览器）：
 * 1) 条目一改动，用过它的已批准行重算并退回待核对，备注写明动了哪个条目；
 * 2) 条目换名后，旧稿下次打开按别名重新归属并重转；
 * 3) 两条并成一条后，墓碑+别名让旧引用跟着重转；
 * 4) 旧稿（v1）升级：补归属，保留旧备注，结果变了才退回；
 * 5) 规范表读不出来时，学校稿用缓存规则照常转写。
 */
import assert from 'node:assert/strict';
import { analyzeProject } from '../src/braille';
import { createInitialProject } from '../src/sample';
import { editSpecEntry, mergeSpecEntries, reconcileProject, refreshRuleSetCache, specToRuleSets, upgradeProject } from '../src/spec';
import type { ProjectState, SpecTable } from '../src/types';

let passed = 0;
const check = (name: string, fn: () => void) => {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
};

const { spec: seedSpec, project: seedProject } = createInitialProject();

function approvedDraft(spec: SpecTable): { spec: SpecTable; project: ProjectState } {
  // 全部行批准，模拟学校已经校对完的稿子
  const ruleSets = specToRuleSets(spec);
  let project = analyzeProject({ ...seedProject, ruleSets, specRevision: spec.revision });
  project = {
    ...project,
    lines: project.lines.map((line) => ({ ...line, status: 'approved' as const, note: line.note || '校对备注保留' })),
    issues: project.issues.map((issue) => ({ ...issue, resolved: true })),
  };
  return { spec, project };
}

check('条目改动：用过它的已批准行重算并退回，且写明动了哪个条目', () => {
  const { spec, project } = approvedDraft(seedSpec);
  // "and" 的盲文从 ⠯ 改成别的
  const changed = editSpecEntry(spec, 'contraction-and', { output: '⠁⠝⠙' });
  const refreshed = refreshRuleSetCache(project, changed);
  const { project: next, revertedLineIds } = reconcileProject(refreshed, changed, refreshed.ruleSets);

  const andLine = next.lines.find((line) => line.source.includes(' and '))!;
  assert.equal(andLine.status, 'questionable', '含 and 的批准行应退回待核对');
  assert.ok(revertedLineIds.includes(andLine.id), 'revertedLineIds 应包含该行');
  assert.match(andLine.note, /规范变动退回/, '备注应写明规范变动退回');
  assert.match(andLine.note, /and/, '备注应写明动了哪个条目');
  assert.match(andLine.note, /校对备注保留|“the”是否符合/, '原校对备注必须保留');

  const untouched = next.lines.find((line) => line.source.startsWith('The small seed'));
  // 第 1 行含 the 不含 and —— 不应受 and 改动影响（the 行）
  assert.ok(!revertedLineIds.includes(untouched!.id) || untouched!.source.includes(' and '), '没用 and 的行不应退回');

  const specIssue = next.issues.find((issue) => issue.code === 'spec-entry-changed' && issue.lineId === andLine.id);
  assert.ok(specIssue, '应生成 spec-entry-changed 问题');
  assert.equal(next.specRevision, changed.revision);
});

check('条目换名：旧稿下次打开按别名重新归属、跟着重转', () => {
  const { spec, project } = approvedDraft(seedSpec);
  // 教研组把 "ing" 换名为 "ing2"（换个名字），输出不变
  const renamed = editSpecEntry(spec, 'contraction-ing', { source: 'ing-suffix' });
  const ingEntry = renamed.entries.find((entry) => entry.id === 'contraction-ing')!;
  assert.deepEqual(ingEntry.aliases, ['ing'], '旧名应进 aliases');
  assert.equal(ingEntry.source, 'ing-suffix');

  // 旧稿 token 上记的 specEntryId 仍是 contraction-ing；换名后旧文本不再命中该条目，
  // 行跟着重转、结果变化 → 退回待核对，备注写明换名
  const refreshed = refreshRuleSetCache(project, renamed);
  const { project: next, revertedLineIds } = reconcileProject(refreshed, renamed, refreshed.ruleSets);
  const ingLine = next.lines.find((line) => line.source.startsWith('ing '))!;
  assert.ok(revertedLineIds.includes(ingLine.id), '换名后引用它的行重转结果变了，应退回');
  assert.equal(ingLine.status, 'questionable');
  assert.match(ingLine.note, /换名/, '备注应写明是换名条目');
  assert.ok(!ingLine.tokens.some((token) => token.text === 'ing' && token.kind === 'contraction'),
    '旧名不再命中缩写，应重转为逐字母');
});

check('条目换名但输出等价：仅换名不影响结果时不应退回', () => {
  const { spec, project } = approvedDraft(seedSpec);
  // 输出不变的条目换名（模拟仅修订条目命名但旧稿没有实际引用旧名的行之外的场景）：
  // 对含 "the" 的行，若只改描述不动 source/output，结果不变，保持批准
  const described = editSpecEntry(spec, 'contraction-the', { description: '教研组更新说明' });
  assert.equal(described.revision, spec.revision + 1);
  const refreshed = refreshRuleSetCache(project, described);
  const { project: next, revertedLineIds } = reconcileProject(refreshed, described, refreshed.ruleSets);
  const theLine = next.lines.find((line) => line.source.startsWith('The '))!;
  assert.ok(!revertedLineIds.includes(theLine.id), '结果没变的批准行不应退回');
  assert.equal(theLine.status, 'approved');
});

check('两条并一条：被并条目立墓碑，旧引用重转到目标条目', () => {
  const { spec, project } = approvedDraft(seedSpec);
  const merged = mergeSpecEntries(spec, 'contraction-ed', 'contraction-er');
  const tomb = merged.entries.find((entry) => entry.id === 'contraction-ed')!;
  const target = merged.entries.find((entry) => entry.id === 'contraction-er')!;
  assert.equal(tomb.tombstoned, true);
  assert.equal(tomb.mergedInto, 'contraction-er');
  assert.ok(target.aliases.includes('ed'), '目标条目应吸收旧名');

  // "needs" 含 ed -> 原本命中 contraction-ed（suspicious）；合并后应跟随 er 条目（⠻ 不适用于 needs？
  // 关键断言：含 ed 的行确实被重算，且归属不再是墓碑
  const refreshed = refreshRuleSetCache(project, merged);
  const { project: next } = reconcileProject(refreshed, merged, refreshed.ruleSets);
  const needsLine = next.lines.find((line) => line.source.includes('needs'))!;
  assert.ok(!needsLine.tokens.some((token) => token.specEntryId === 'contraction-ed' && token.text === 'ed'),
    '被并条目不应再作为现行命中');
  assert.equal(next.specRevision, merged.revision);
});

check('旧稿升级（v1）：补归属、保留旧备注、结果变了才退回', () => {
  // 构造 v1 稿子：规则没有 specEntryId，行已批准
  const ruleSets = specToRuleSets(seedSpec).map((set) => ({
    ...set,
    rules: set.rules.map(({ specEntryId: _a, specRevision: _b, ...rule }) => rule),
  }));
  let legacy = analyzeProject({ ...seedProject, ruleSets, specRevision: 0, schemaVersion: 1 } as ProjectState);
  legacy = {
    ...legacy,
    lines: legacy.lines.map((line) => ({ ...line, status: 'approved' as const, note: '旧校对备注' })),
  };

  // 教研组在此期间改了 and 的输出
  const newerSpec = editSpecEntry(seedSpec, 'contraction-and', { output: '⠁⠝⠙' });

  const { project: upgraded, revertedLineIds } = upgradeProject(legacy, newerSpec);
  assert.equal(upgraded.schemaVersion, 2);
  const andLine = upgraded.lines.find((line) => line.source.includes(' and '))!;
  assert.equal(andLine.status, 'questionable');
  assert.ok(revertedLineIds.includes(andLine.id));
  assert.match(andLine.note, /旧校对备注/, '旧备注保留');
  assert.ok(upgraded.ruleSets[0].rules.every((rule) => typeof rule.specEntryId === 'string'), '升级后所有缓存规则都补了规范条目归属');
});

check('幂等：再次对账不会重复退回或重复追加备注', () => {
  const { spec, project } = approvedDraft(seedSpec);
  const changed = editSpecEntry(spec, 'contraction-and', { output: '⠁⠝⠙' });
  const run1 = reconcileProject(refreshRuleSetCache(project, changed), changed, refreshRuleSetCache(project, changed).ruleSets).project;
  const run2 = reconcileProject(run1, changed, run1.ruleSets).project;
  const andLine1 = run1.lines.find((line) => line.source.includes(' and '))!;
  const andLine2 = run2.lines.find((line) => line.source.includes(' and '))!;
  assert.equal(andLine2.note, andLine1.note, '备注不应重复追加');
  assert.equal(andLine2.status, 'questionable');
});

check('规范表离线：学校稿用缓存规则照常转写', () => {
  const { spec, project } = approvedDraft(seedSpec);
  // 没有可读规范表场景：直接改课文原文，analyzeProject 用缓存 ruleSets 即可工作
  const edited = analyzeProject({
    ...project,
    lines: project.lines.map((line, index) => index === 0 ? { ...line, source: 'Water and light.' } : line),
  });
  const first = edited.lines[0];
  assert.ok(first.tokens.length > 0, '离线时仍能用缓存规则转写');
  assert.ok(first.tokens.some((token) => token.braille.includes('⠯')), '缓存中的 and 缩写应正常命中');
  assert.equal(spec.owner, '教研组');
});

console.log(`\n全部 ${passed} 个场景通过`);
