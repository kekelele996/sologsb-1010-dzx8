/**
 * 启动与持久化场景（localStorage 垫片）：
 * A) 首次启动写入规范表 + v2 稿；
 * B) 只有 v1 旧稿时启动 → 升级为 v2，旧备注保留；
 * C) 规范表读不出来（JSON 损坏且无备份）→ 稿子照常打开，specReadable=false；
 * D) 保存失败（配额异常）→ 上一版仍在 .backup，且稿子本身不被清空。
 */
import assert from 'node:assert/strict';

class MemoryStorage {
  private map = new Map<string, string>();
  private blocked = new Set<string>();
  setItem(key: string, value: string) {
    if (this.blocked.has(key)) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
    this.map.set(key, value);
  }
  getItem(key: string) {
    if (this.blocked.has(key)) throw new Error('blocked');
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  removeItem(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); this.blocked.clear(); }
  block(key: string) { this.blocked.add(key); }
  unblock(key: string) { this.blocked.delete(key); }
  has(key: string) { return this.map.has(key); }
  raw(key: string) { return this.map.get(key); }
}

const storage = new MemoryStorage();
(globalThis as any).localStorage = storage;
(globalThis as any).DOMException = class extends Error {
  constructor(message: string, _name?: string) { super(message); this.name = 'QuotaExceededError'; }
};

const { bootstrapWorkspace } = await import('../src/workspace');
const { loadJSON, loadSpec, DRAFT_KEY, LEGACY_DRAFT_KEY, SPEC_KEY, persistJSON } = await import('../src/storage');
const { createInitialProject } = await import('../src/sample');

let passed = 0;
const check = (name: string, fn: () => void) => { fn(); passed += 1; console.log(`✓ ${name}`); };

check('A) 首次启动：两侧数据分别落盘', () => {
  storage.clear();
  const boot = bootstrapWorkspace();
  assert.equal(boot.specReadable, true);
  assert.ok(storage.has(SPEC_KEY), '规范表已写入');
  assert.ok(storage.has(DRAFT_KEY), '课文稿已写入');
  assert.equal(boot.project.schemaVersion, 2);
  assert.equal(boot.project.specRevision, boot.spec.revision);
});

check('B) v1 旧稿升级：自动按规范表补归属并落 v2', () => {
  storage.clear();
  const { spec, project } = createInitialProject();
  storage.setItem(SPEC_KEY, JSON.stringify(spec));
  // 模拟旧版 v1 稿：无 schemaVersion / specRevision
  const v1 = { ...project };
  delete (v1 as Partial<ProjectStateLike>).schemaVersion;
  delete (v1 as Partial<ProjectStateLike>).specRevision;
  storage.setItem(LEGACY_DRAFT_KEY, JSON.stringify(v1));
  assert.ok(!storage.has(DRAFT_KEY));

  const boot = bootstrapWorkspace();
  assert.equal(boot.specReadable, true);
  assert.equal(boot.upgradedFromRevision, 1);
  assert.ok(storage.has(DRAFT_KEY), '升级稿已写入 v2 键');
  const saved = JSON.parse(storage.raw(DRAFT_KEY)!);
  assert.equal(saved.schemaVersion, 2);
  assert.ok(saved.lines.length === project.lines.length);
});

check('C) 规范表损坏：稿子照常打开，规范侧标记不可读', () => {
  storage.clear();
  const { project } = createInitialProject();
  storage.setItem(SPEC_KEY, '{这不是合法JSON');
  storage.setItem(DRAFT_KEY, JSON.stringify(project));
  const boot = bootstrapWorkspace();
  assert.equal(boot.specReadable, false, '规范表不可读');
  assert.ok(boot.specLoadError);
  assert.equal(boot.project.lines.length, project.lines.length, '课文稿照常装载');
});

check('C2) 主稿损坏但备份可用：回退到上一版', () => {
  storage.clear();
  const { project } = createInitialProject();
  storage.setItem(`${DRAFT_KEY}.backup`, JSON.stringify(project));
  storage.setItem(DRAFT_KEY, '损坏');
  const result = loadJSON(DRAFT_KEY);
  assert.ok(result.data, '应从备份恢复');
  assert.ok(result.hadBackup);
});

check('D) 保存失败：上一版先留着（主键不被破坏，备份为更早一版）', () => {
  storage.clear();
  const { project } = createInitialProject();
  persistJSON(DRAFT_KEY, project);
  persistJSON(DRAFT_KEY, { ...project, title: '上一版标题' });
  storage.block(DRAFT_KEY);
  assert.throws(() => persistJSON(DRAFT_KEY, { ...project, title: '写不进去的新版' }));
  storage.unblock(DRAFT_KEY);
  // 新值写入失败：主键仍是失败前的上一版，没有被半截数据破坏
  const current = loadJSON<{ title: string }>(DRAFT_KEY);
  assert.ok(current.data);
  assert.equal(current.data.title, '上一版标题');
  // 备份里保留着更早一版，可再往前回滚
  const backup = loadJSON<{ title: string }>(DRAFT_KEY + '.backup');
  assert.ok(backup.data);
  assert.equal(backup.data.title, project.title);
});

check('E) 规范表正常、稿子落后修订号：打开时对账退回', async () => {
  storage.clear();
  const { editSpecEntry } = await import('../src/spec');
  const { spec, project } = createInitialProject();
  // 学校稿：行全部批准、停在 r1
  const approved = {
    ...project,
    specRevision: spec.revision,
    lines: project.lines.map((line) => ({ ...line, status: 'approved' as const, note: line.note || '已校对' })),
  };
  storage.setItem(DRAFT_KEY, JSON.stringify(approved));
  // 教研组发布 r2：改 and 输出
  const r2 = editSpecEntry(spec, 'contraction-and', { output: '⠁⠝⠙' });
  storage.setItem(SPEC_KEY, JSON.stringify(r2));

  const boot = bootstrapWorkspace();
  assert.ok(boot.revertedLineIds.length > 0, '打开时应退回受影响批准行');
  const andLine = boot.project.lines.find((line) => line.source.includes(' and '))!;
  assert.equal(andLine.status, 'questionable');
  assert.match(andLine.note, /规范变动退回[\s\S]*and/);
  assert.equal(boot.project.specRevision, r2.revision);
});

interface ProjectStateLike { schemaVersion: number; specRevision: number }
void loadSpec;

console.log(`\n全部 ${passed} 个启动场景通过`);
