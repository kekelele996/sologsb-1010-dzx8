import { analyzeProject, detectRuleChanges, diffRuleSets, mergeRules, normalizeProject, updateRuleInSet } from '../src/braille';
import { bootProject } from '../src/boot';
import { createDefaultRuleSets, createInitialProject } from '../src/sample';
import { readDraft, readStandards, toDraftDoc, writeDraft, writeStandards } from '../src/storage';
import type { ProjectState, RuleSet, TextbookLine } from '../src/types';

// ---- localStorage mock ----
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures += 1; console.log(`  ✗ ${name} ${extra}`); }
}

const activeSet = (p: ProjectState) => p.ruleSets.find((r) => r.id === p.activeRuleSetId) ?? p.ruleSets[0];
const lineOf = (p: ProjectState, id: string) => p.lines.find((l) => l.id === id)!;
const brailleOf = (l: TextbookLine) => l.tokens.map((t) => t.braille).join('');

// ---- 1. 条目改动 → 引用行重算；批准行结果变了退回待核对并写明条目 ----
console.log('场景1：规范条目改动，批准行退回待核对');
{
  let project = createInitialProject();
  // 学校批准第 2 行（含 and，用到 contraction-and）
  project = {
    ...project,
    lines: project.lines.map((l) => (l.id === 'line-2' ? { ...l, status: 'approved' as const } : l)),
  };
  const before = brailleOf(lineOf(project, 'line-2'));
  check('第2行转写用到 and 缩写', before.includes('⠯'));

  // 教研组修改条目 and 的输出
  const ruleSet = activeSet(project);
  const nextSet = updateRuleInSet(ruleSet, 'contraction-and', { output: '⠈⠯' });
  check('条目改动后 revision 递增', nextSet.rules.find((r) => r.id === 'contraction-and')!.revision === 2);
  const changes = diffRuleSets(ruleSet, nextSet);
  check('diff 列出改动条目', changes.length === 1 && changes[0].detail.includes('「and」'));

  project = analyzeProject(
    { ...project, ruleSets: project.ruleSets.map((r) => (r.id === nextSet.id ? nextSet : r)) },
    { changes },
  );
  const line2 = lineOf(project, 'line-2');
  check('引用行已重算', brailleOf(line2).includes('⠈⠯'));
  check('批准行结果改变 → 退回待核对', line2.status === 'questionable');
  check('备注写明动了哪个条目', line2.note.includes('[规范变更]') && line2.note.includes('「and」'));
  check('问题区生成 rule-changed 提醒', project.issues.some((i) => i.code === 'rule-changed' && i.lineId === 'line-2'));
  // 未受影响的批准行保持批准
  project = { ...project, lines: project.lines.map((l) => (l.id === 'line-3' ? { ...l, status: 'approved' as const } : l)) };
  const line3Before = brailleOf(lineOf(project, 'line-3'));
  project = analyzeProject(project, { changes });
  check('未受影响的批准行保持批准', lineOf(project, 'line-3').status === 'approved' && brailleOf(lineOf(project, 'line-3')) === line3Before);
}

// ---- 2. 条目换名 / 两条并成一条 → 下次打开跟着重转 ----
console.log('场景2：换名与合并，下次打开重转');
{
  let project = createInitialProject();
  // 加一行含 of 的课文并批准，覆盖“两条并成一条”的引用场景
  project = analyzeProject({
    ...project,
    lines: [...project.lines, { id: 'line-of', source: 'A cup of water.', tokens: [], status: 'unchecked', note: '', continuesPrevious: false, continuesNext: false }],
  });
  project = {
    ...project,
    lines: project.lines.map((l) => (l.id === 'line-2' || l.id === 'line-of' ? { ...l, status: 'approved' as const } : l)),
  };
  const stamps = lineOf(project, 'line-2').stamps!;
  check('行已记录归属印记', stamps['contraction-and']?.revision === 1);
  const ofLineBefore = brailleOf(lineOf(project, 'line-of'));
  check('of 行用到 of 缩写', ofLineBefore.includes('⠷'));

  // 教研组把 and 改名为 an，并把 of 并入 with
  let ruleSet = activeSet(project);
  ruleSet = updateRuleInSet(ruleSet, 'contraction-and', { source: 'an' });
  ruleSet = mergeRules(ruleSet, 'contraction-of', 'contraction-with');
  const surviving = ruleSet.rules.find((r) => r.id === 'contraction-with')!;
  check('合并后别名记录旧条目', surviving.aliases.includes('contraction-of'));
  check('被并条目已移除', !ruleSet.rules.some((r) => r.id === 'contraction-of'));

  // 模拟下次打开：只有行上的印记 + 新规范表
  const changes = detectRuleChanges(project.lines, ruleSet);
  check('检测到换名', changes.some((c) => c.kind === 'renamed' && c.detail.includes('「and」改名为「an」')));
  check('检测到合并', changes.some((c) => c.kind === 'merged' && c.detail.includes('并入「with」')));

  const line2Before = brailleOf(lineOf(project, 'line-2'));
  const reopened = analyzeProject({ ...project, ruleSets: project.ruleSets.map((r) => (r.id === ruleSet.id ? ruleSet : r)) }, { changes });
  const line2 = reopened.lines.find((l) => l.id === 'line-2')!;
  const ofLine = reopened.lines.find((l) => l.id === 'line-of')!;
  check('引用行跟着重转（an 缩写只覆盖前两个字母）', brailleOf(line2) !== line2Before);
  check('被并条目的引用行重转（of 不再用 ⠷）', !brailleOf(ofLine).includes('⠷'));
  check('批准行退回待核对', line2.status === 'questionable' && ofLine.status === 'questionable');
  check('备注写明条目', line2.note.includes('「and」') && ofLine.note.includes('「of」'));
  check('重转后归属印记刷新', line2.stamps!['contraction-and']?.revision === 2);
}

// ---- 3. 旧稿升级：按规范表补归属，兼容旧校对备注 ----
console.log('场景3：旧稿升级');
{
  const legacy = JSON.parse(JSON.stringify(createInitialProject())) as any;
  // 模拟 v1 旧稿：无 revision/aliases/stamps/ruleSetId，备注用 remark 字段
  legacy.ruleSets.forEach((rs: RuleSet) => rs.rules.forEach((r: any) => { delete r.revision; delete r.aliases; }));
  legacy.lines.forEach((l: any, i: number) => {
    delete l.stamps; delete l.ruleSetId;
    if (i === 0) { l.remark = '旧版校对备注：待确认'; delete l.note; }
    if (i === 1) l.status = 'approved';
  });
  const upgraded = normalizeProject(legacy as ProjectState);
  check('旧条目补默认版本与别名', upgraded.ruleSets[0].rules.every((r) => r.revision === 1 && Array.isArray(r.aliases)));
  check('旧校对备注兼容（remark → note）', upgraded.lines[0].note === '旧版校对备注：待确认');
  const reanalyzed = analyzeProject(upgraded);
  check('按规范表补归属（stamps）', Object.keys(reanalyzed.lines[1].stamps!).length > 0);
  check('补归属不改变已批准状态', reanalyzed.lines[1].status === 'approved');
  check('行记录所用规范表', reanalyzed.lines[1].ruleSetId === reanalyzed.activeRuleSetId);
}

// ---- 4. 规范表读不出来 → 稿子照旧能改；保存失败重试、上一版先留着 ----
console.log('场景4：容错');
{
  store.clear();
  writeStandards(createDefaultRuleSets());
  check('规范表正常读取', readStandards().degraded === false);
  store.set('sologsb-1010-standards-v2', '{损坏的json');
  const result = readStandards();
  check('规范表读不出来 → 降级标记', result.degraded === true && result.ruleSets === null);

  // 课文稿保存：先留上一版
  const project = createInitialProject();
  writeDraft(toDraftDoc(project));
  const v1 = store.get('sologsb-1010-draft-v2')!;
  const project2 = { ...project, title: '改过的标题' };
  writeDraft(toDraftDoc(project2));
  check('主稿已更新', store.get('sologsb-1010-draft-v2') !== v1);
  check('上一版先留着', store.get('sologsb-1010-draft-v2-previous') === v1);
  check('暂存已清理', !store.has('sologsb-1010-draft-v2-stage'));

  // 保存中途失败（暂存成功、主稿失败）→ 恢复时取学校侧最新
  store.set('sologsb-1010-draft-v2-stage', JSON.stringify({ ...toDraftDoc(project2), title: '写到一半的版本' }));
  const recovered = readDraft();
  check('写到一半也能恢复学校侧最新稿', recovered?.title === '写到一半的版本');

  // 主稿损坏 → 回退上一版
  store.delete('sologsb-1010-draft-v2-stage');
  store.set('sologsb-1010-draft-v2', '###损坏###');
  const fallback = readDraft();
  check('主稿损坏回退上一版', fallback?.title === project.title);
}

// ---- 5. 启动装配：各自维护、跨会话变更、旧稿迁移、降级 ----
console.log('场景5：启动装配（boot）');
{
  // 5a. 学校保存课文稿后，教研组在另一会话改了规范表 → 下次打开跟着重转
  store.clear();
  let project = createInitialProject();
  project = { ...project, lines: project.lines.map((l) => (l.id === 'line-2' ? { ...l, status: 'approved' as const } : l)) };
  writeStandards(project.ruleSets);
  writeDraft(toDraftDoc(project));

  // 教研组会话：停用 for 条目（line-1 之外，line-2 不含 for，改用 and 输出变更影响 line-2）
  const standards = readStandards().ruleSets!;
  const idx = standards.findIndex((r) => r.id === 'ueb-teaching');
  standards[idx] = updateRuleInSet(standards[idx], 'contraction-and', { output: '⠈⠯' });
  writeStandards(standards);

  const boot = bootProject();
  const bootLine2 = boot.project.lines.find((l) => l.id === 'line-2')!;
  check('下次打开检测到条目变更并重算', brailleOf(bootLine2).includes('⠈⠯'));
  check('批准行退回待核对', bootLine2.status === 'questionable');
  check('启动提示写明退回行数', boot.notice.includes('1 行已批准内容因规范条目变更结果改变'));
  check('规范表未降级', boot.standardsDegraded === false);

  // 5b. 只有旧版合并存储 → 自动升级拆分
  store.clear();
  const legacy = JSON.parse(JSON.stringify(project)) as any;
  legacy.lines[0].remark = '旧备注：缩写进度待确认';
  delete legacy.lines[0].note;
  legacy.lines.forEach((l: any) => { delete l.stamps; delete l.ruleSetId; });
  legacy.ruleSets.forEach((rs: RuleSet) => rs.rules.forEach((r: any) => { delete r.revision; delete r.aliases; }));
  store.set('sologsb-1010-braille-project-v1', JSON.stringify(legacy));
  const migrated = bootProject();
  check('旧稿升级提示', migrated.notice.includes('旧稿已升级'));
  check('旧校对备注兼容', migrated.project.lines[0].note === '旧备注：缩写进度待确认');
  check('升级后按规范表补归属', Object.keys(migrated.project.lines[1].stamps!).length > 0);
  check('升级后批准状态保留', migrated.project.lines[1].status === 'approved');

  // 5c. 规范表损坏 → 降级，稿子照旧能改（沿用已存结果，不重转）
  store.clear();
  writeDraft(toDraftDoc(project));
  store.set('sologsb-1010-standards-v2', '{{{损坏');
  const degraded = bootProject();
  check('规范表读不出来 → 降级', degraded.standardsDegraded === true);
  check('沿用草稿已存结果', degraded.project.lines.length === project.lines.length && brailleOf(degraded.project.lines[1]) === brailleOf(project.lines[1]));
  check('稿子内容完整可改', degraded.project.lines.every((l) => typeof l.source === 'string'));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
