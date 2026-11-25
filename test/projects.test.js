'use strict';

// 长期项目（P5）：纯函数 + 与 life / prompt 的集成测试。
// 不联网、不调模型；临时目录只用于 store 读写。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projects = require('../src/main/projects');
const life = require('../src/main/life');
const prompt = require('../src/main/prompt');
const store = require('../src/main/store');

const NOW = new Date(2026, 9, 26, 9, 0, 0, 0); // 本地 2026-10-26 09:00
const DATE = '2026-10-26';
const EVENING_NOW = new Date(2026, 9, 26, 20, 30, 0, 0);

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'she-projects-'));
}

function settings(overrides = {}) {
  return {
    life: {
      enabled: true,
      quietFrom: '23:30',
      quietTo: '08:00',
      proactivePerDay: 2,
      maxBackgroundCallsPerDay: 24,
      useWeather: false,
      ...overrides,
    },
  };
}

function character(overrides = {}) {
  return {
    id: 'char-proj',
    name: '她',
    persona: {
      traits: ['温柔'],
      speechStyle: '短句',
      likes: [],
    },
    life: {
      city: '上海',
      home: '徐汇的小房子',
      occupation: '自由插画师',
      hobbies: ['逛书店'],
      tone: '松弛',
    },
    ...overrides,
  };
}

function book(overrides = {}) {
  return {
    id: 'p1',
    title: '读完《夜晚的潜水艇》',
    kind: 'book',
    progress: 3,
    total: 12,
    startedAt: '2026-10-20',
    status: 'active',
    unit: '页',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeProjects
// ---------------------------------------------------------------------------

test('normalizeProjects：非数组 / 字符串 / 非对象条目一律返回空数组', () => {
  assert.deepEqual(projects.normalizeProjects(null), []);
  assert.deepEqual(projects.normalizeProjects(undefined), []);
  assert.deepEqual(projects.normalizeProjects('读完一本书'), []);
  assert.deepEqual(projects.normalizeProjects(42), []);
  assert.deepEqual(projects.normalizeProjects([null, 'x', 3, []]), []);
});

test('normalizeProjects：补全 id、缺标题丢弃、进度夹取、单位按类型兜底', () => {
  const list = projects.normalizeProjects([
    { title: '练会《月光》', kind: 'music', progress: 99, total: 8 },
    { id: 'p9', title: '画完速写本', kind: 'drawing', progress: -3, total: 0 },
    { id: 'p9', title: '重名的项目', kind: 'unknown', progress: '2', total: '5' },
    { id: '', title: '', kind: 'book' },
  ], NOW);

  assert.equal(list.length, 3);
  assert.equal(list[0].id, 'p1', '缺 id 时按序号补');
  assert.equal(list[0].progress, 8, 'progress 超过 total 时截到 total');
  assert.equal(list[0].status, 'done', 'progress 到顶即完成');
  assert.equal(list[0].unit, '首');

  assert.equal(list[1].progress, 0, '负数进度夹到 0');
  assert.equal(list[1].total, 1, 'total 非法时至少为 1');
  assert.equal(list[1].unit, '张');

  assert.equal(list[2].kind, 'other', '未知类型归到 other');
  assert.equal(list[2].id, 'p9-3', '重复 id 追加后缀');
  assert.equal(list[2].progress, 2);
  assert.equal(list[2].startedAt, DATE, '缺 startedAt 用当天日期');
});

test('normalizeProjects：status 显式 done 时进度补齐到 total，且不改入参', () => {
  const raw = [book({ progress: 4, status: 'done' })];
  const snapshot = JSON.parse(JSON.stringify(raw));
  const list = projects.normalizeProjects(raw, NOW);
  assert.equal(list[0].progress, 12);
  assert.equal(list[0].status, 'done');
  assert.deepEqual(raw, snapshot, '不改入参');
});

// ---------------------------------------------------------------------------
// activeProject
// ---------------------------------------------------------------------------

test('activeProject：按 startedAt 取最早的进行中项目，全完成返回 null', () => {
  const list = [
    book({ id: 'p2', startedAt: '2026-10-22' }),
    book({ id: 'p1', startedAt: '2026-10-20' }),
    book({ id: 'p3', startedAt: '2026-10-19', progress: 12, status: 'done' }),
  ];
  const active = projects.activeProject(list);
  assert.equal(active.id, 'p1');

  assert.equal(projects.activeProject([book({ status: 'done', progress: 12 })]), null);
  assert.equal(projects.activeProject(null), null);
});

// ---------------------------------------------------------------------------
// advanceProject
// ---------------------------------------------------------------------------

test('advanceProject：正常 +1，返回新数组且不改入参', () => {
  const raw = [book()];
  const snapshot = JSON.parse(JSON.stringify(raw));
  const result = projects.advanceProject(raw, 'p1', 1);

  assert.equal(result.completed, false);
  assert.equal(result.project.progress, 4);
  assert.equal(result.projects[0].progress, 4);
  assert.equal(result.projects[0].status, 'active');
  assert.deepEqual(raw, snapshot, '不改入参');
  assert.notStrictEqual(result.projects, raw, '返回新数组');
});

test('advanceProject：进度越界时夹到 total 并标记完成', () => {
  const result = projects.advanceProject([book({ progress: 10 })], 'p1', 5);
  assert.equal(result.project.progress, 12);
  assert.equal(result.project.status, 'done');
  assert.equal(result.completed, true);
});

test('advanceProject：已完成的项目不再推进，completed 也不再为 true', () => {
  const done = book({ progress: 12, status: 'done' });
  const result = projects.advanceProject([done], 'p1', 1);
  assert.equal(result.project.progress, 12);
  assert.equal(result.completed, false);
  assert.equal(result.projects[0].progress, 12);
});

test('advanceProject：未知 id / 非正 delta 不推进', () => {
  const missing = projects.advanceProject([book()], 'nope', 1);
  assert.equal(missing.project, null);
  assert.equal(missing.completed, false);
  assert.equal(missing.projects[0].progress, 3);

  assert.equal(projects.advanceProject([book()], 'p1', 0).project.progress, 3);
  assert.equal(projects.advanceProject([book()], 'p1', -2).project.progress, 3);
  assert.equal(projects.advanceProject([book()], 'p1', 'x').project.progress, 3);
});

// ---------------------------------------------------------------------------
// 文案与活动
// ---------------------------------------------------------------------------

test('projectLine：进行中给「第 x/y 单位」，已完成给「已完成」', () => {
  assert.equal(projects.projectLine(book()), '「读完《夜晚的潜水艇》」第 3/12 页');
  assert.equal(
    projects.projectLine(book({ progress: 12, status: 'done' })),
    '「读完《夜晚的潜水艇》」已完成（12/12 页）',
  );
  assert.equal(projects.projectLine(null), '');
  // 标题没带书名号时自动补
  assert.equal(
    projects.projectLine({ title: '随手速写', kind: 'drawing', progress: 1, total: 5 }),
    '「随手速写」第 1/5 张',
  );
});

test('projectActivity：时间落在 19:00–22:00，同一天稳定，文案按类型变化', () => {
  const first = projects.projectActivity(book(), NOW);
  const sameDayLater = projects.projectActivity(book(), new Date(2026, 9, 26, 23, 50));
  assert.equal(first.category, 'project');
  assert.ok(first.time >= '19:00' && first.time <= '22:00', `实际 ${first.time}`);
  assert.deepEqual(first, sameDayLater, '同一天同一项目结果稳定');
  assert.match(first.activity, /《夜晚的潜水艇》/);

  const music = projects.projectActivity(book({ id: 'p2', kind: 'music', title: '练会《月光》' }), NOW);
  assert.match(music.activity, /练/);
});

test('ensureProjectEntry：不替用户创建默认项目，恒返回 null', () => {
  assert.equal(projects.ensureProjectEntry(character()), null);
  assert.equal(projects.ensureProjectEntry(character({ life: { projects: [book()] } })), null);
  assert.equal(projects.ensureProjectEntry(null), null);
});

// ---------------------------------------------------------------------------
// 集成：日程
// ---------------------------------------------------------------------------

test('ensureSchedule：有进行中的项目时晚间出现 category:project 条目', async () => {
  const dir = tempDir();
  const c = character({ life: { ...character().life, projects: [book()] } });
  const result = await life.ensureSchedule({
    dir, character: c, date: DATE, settings: settings(), now: NOW,
  });
  const schedule = result.timeline.days[DATE].schedule;
  const item = schedule.find((row) => row.category === 'project');
  assert.ok(item, '应安排一条推进项目的活动');
  assert.ok(item.time >= '19:00' && item.time <= '22:00', `实际 ${item.time}`);
  assert.match(item.activity, /夜晚的潜水艇/);
  assert.ok(schedule.length >= 3 && schedule.length <= 6, `实际 ${schedule.length} 条`);
});

test('ensureSchedule：没有项目时日程里不出现项目条目', async () => {
  const dir = tempDir();
  const result = await life.ensureSchedule({
    dir, character: character(), date: DATE, settings: settings(), now: NOW,
  });
  const schedule = result.timeline.days[DATE].schedule;
  assert.equal(schedule.some((row) => row.category === 'project'), false);
});

test('ensureSchedule：昨天已推进过项目时今天不再安排（每 1–2 天一次）', async () => {
  const dir = tempDir();
  store.writeTimeline(dir, 'char-proj', {
    days: {
      '2026-10-25': {
        schedule: [{ time: '20:00', activity: '读完《夜晚的潜水艇》十页', category: 'project' }],
        events: [],
      },
    },
  });
  const c = character({ life: { ...character().life, projects: [book()] } });
  const result = await life.ensureSchedule({
    dir, character: c, date: DATE, settings: settings(), now: NOW,
  });
  const schedule = result.timeline.days[DATE].schedule;
  assert.equal(schedule.some((row) => row.category === 'project'), false);
});

// ---------------------------------------------------------------------------
// 集成：事件推进 / 完成
// ---------------------------------------------------------------------------

function timelineWithProject() {
  return {
    days: {
      [DATE]: {
        schedule: [{ time: '20:00', activity: '读完《夜晚的潜水艇》十页', category: 'project' }],
        events: [],
      },
    },
  };
}

test('advanceEvents：触发项目条目后进度 +1，事件文本带进度并落盘', () => {
  const dir = tempDir();
  const c = character({ life: { ...character().life, projects: [book()] } });
  store.saveCharacter(dir, c);

  const result = life.advanceEvents({
    timeline: timelineWithProject(), now: EVENING_NOW, character: c, dir,
  });
  assert.equal(result.fired.length, 1);
  const event = result.fired[0];
  assert.equal(event.category, 'project');
  assert.equal(event.projectProgress, 4);
  assert.match(event.text, /读到第 4\/12 页/);
  assert.equal(event.projectDone, undefined);

  assert.equal(result.character.life.projects[0].progress, 4);
  const stored = store.listCharacters(dir)[0];
  assert.equal(stored.life.projects[0].progress, 4, '进度应写回 character.json');
});

test('advanceEvents：到 total 时标记完成、写记忆卡并在 timeline 记一条完成记录', () => {
  const dir = tempDir();
  const c = character({ life: { ...character().life, projects: [book({ progress: 11 })] } });
  store.saveCharacter(dir, c);

  const result = life.advanceEvents({
    timeline: timelineWithProject(), now: EVENING_NOW, character: c, dir,
  });
  assert.equal(result.completedProjects.length, 1);
  assert.equal(result.completedProjects[0].status, 'done');
  assert.equal(result.completedProjects[0].progress, 12);

  const day = result.timeline.days[DATE];
  const note = day.events.find((item) => item.projectDone === true && !item.scheduleTime);
  assert.ok(note, 'timeline 当天应留下完成记录');
  assert.match(note.text, /读完了/);

  const stored = store.listCharacters(dir)[0];
  assert.equal(stored.life.projects[0].status, 'done');

  const memory = store.readMemory(dir, 'char-proj');
  const card = memory.cards.find((item) => item.kind === 'event' && /读完了/.test(item.text));
  assert.ok(card, '应写一条 event 记忆卡');
  assert.match(card.text, /夜晚的潜水艇/);

  // 再次推进不会重复完成，也不会重复写记忆
  const again = life.advanceEvents({
    timeline: { days: { [DATE]: { schedule: [{ time: '21:00', activity: '再读几页', category: 'project' }], events: [] } } },
    now: EVENING_NOW,
    character: result.character,
    dir,
  });
  assert.equal(again.completedProjects.length, 0);
  assert.equal(store.readMemory(dir, 'char-proj').cards.length, memory.cards.length);
});

// ---------------------------------------------------------------------------
// 集成：聊天「此刻」块
// ---------------------------------------------------------------------------

test('buildChatMessages：有进行中的项目时「此刻」块多一行「她手上在做」', () => {
  const withProject = prompt.buildChatMessages({
    character: character({ life: { ...character().life, projects: [book()] } }),
    today: { schedule: [{ time: '09:00', activity: '在窗边坐了一会儿' }], events: [] },
    history: [],
    userText: '在吗',
    now: NOW,
  });
  const moment = withProject.find((message) => message.kind === 'moment');
  assert.ok(moment);
  assert.match(moment.content, /她手上在做：「读完《夜晚的潜水艇》」第 3\/12 页/);

  const withoutProject = prompt.buildChatMessages({
    character: character(),
    today: { schedule: [], events: [] },
    history: [],
    userText: '在吗',
    now: NOW,
  });
  const plain = withoutProject.find((message) => message.kind === 'moment');
  assert.doesNotMatch(plain.content, /她手上在做/);
});
