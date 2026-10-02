import { analyzeProject, detectRuleChanges, diffRuleSets, normalizeProject } from './braille';
import { createDefaultRuleSets, createInitialProject } from './sample';
import { readDraft, readLegacyProject, readStandards, toDraftDoc } from './storage';
import type { ProjectState, RuleChange } from './types';

export interface BootResult {
  project: ProjectState;
  /** 规范表读不出来时为 true：稿子照旧能改，但不再覆盖教研组数据。 */
  standardsDegraded: boolean;
  notice: string;
}

/**
 * 启动时装配两份各自维护的数据：
 * - 规范表（教研组）：读不出来时降级为内置规则，稿子照常编辑；
 * - 课文稿（学校）：旧版合并存储的稿子自动升级，按规范表补归属、保留旧校对备注；
 * - 打开时按行上的归属印记核对规范表，条目改动 / 换名 / 合并的行跟着重转，
 *   已批准的行结果变了就退回待核对并写明动了哪个条目。
 */
export function bootProject(): BootResult {
  const standards = readStandards();
  let ruleSets = standards.ruleSets;
  let draft = readDraft();
  let legacyChanges: RuleChange[] | null = null;
  let notice = '';

  if (!draft) {
    const legacy = readLegacyProject();
    if (legacy) {
      const upgraded = normalizeProject(legacy);
      if (ruleSets) {
        const current = ruleSets.find((ruleSet) => ruleSet.id === upgraded.activeRuleSetId) ?? ruleSets[0];
        const previous = upgraded.ruleSets.find((ruleSet) => ruleSet.id === current.id);
        legacyChanges = previous
          ? diffRuleSets(previous, current)
          : [{ ruleId: '__ruleset__', kind: 'switched', label: current.name, detail: `规范表已切换为「${current.name}」` }];
      } else {
        // 规范表还没有独立存档：沿用旧稿内嵌的那份，升级后自动拆分保存。
        ruleSets = upgraded.ruleSets;
      }
      draft = toDraftDoc(upgraded);
      notice = '旧稿已升级：按规范表补齐归属，旧校对备注已保留';
    }
  }

  if (!draft) {
    return { project: createInitialProject(ruleSets ?? undefined), standardsDegraded: false, notice: '已创建示例项目' };
  }

  if (!ruleSets) {
    const project = normalizeProject({ ...draft, ruleSets: createDefaultRuleSets() });
    if (standards.degraded) {
      return { project, standardsDegraded: true, notice: '规范表读取失败，已沿用草稿已存结果，课文稿可照常编辑' };
    }
    return { project: analyzeProject(project), standardsDegraded: false, notice: '已恢复本地草稿' };
  }

  let project = normalizeProject({ ...draft, ruleSets });
  const activeSet = project.ruleSets.find((ruleSet) => ruleSet.id === project.activeRuleSetId) ?? project.ruleSets[0];
  project = { ...project, activeRuleSetId: activeSet.id };
  const changes = legacyChanges ?? detectRuleChanges(project.lines, activeSet);
  const analyzed = analyzeProject(project, { changes });
  const reverted = analyzed.lines.filter((line, index) => project.lines[index]?.status === 'approved' && line.status === 'questionable').length;
  if (reverted > 0) {
    notice = `${notice ? `${notice}；` : ''}${reverted} 行已批准内容因规范条目变更结果改变，退回待核对`;
  } else if (changes.length > 0) {
    notice = `${notice ? `${notice}；` : ''}规范条目 ${changes.length} 处变更，已重算受影响行`;
  }
  return { project: analyzed, standardsDegraded: false, notice: notice || '已恢复本地草稿' };
}
