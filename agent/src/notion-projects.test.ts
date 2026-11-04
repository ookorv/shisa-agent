import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTION_API, NOTION_PROJECTS, applyNotionTasks, fetchTodayProjects, notionProjectsConf, setNotionProjectState, syncNotionProject } from "./notion-projects.ts";
import { Store } from "./store.ts";
import { Bus } from "./bus.ts";
import { Agent } from "./core.ts";
import { loadConfig } from "./config.ts";

const conf = { token: "secret_test", databaseId: "db1" };
const NOW = new Date(2026, 10, 4, 9, 30).getTime();
type Call = { method: string; url: string; body: any };

function fakeFetch(found: string | null, fail?: { at: string; status: number }) {
  const calls: Call[] = [];
  const fetch = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    if (fail && url.endsWith(fail.at)) return { ok: false, status: fail.status, json: async () => ({ code: "unauthorized", message: "API token is invalid." }) };
    if (url.endsWith("/query")) return { ok: true, status: 200, json: async () => ({ results: found ? [{ id: found }] : [] }) };
    return { ok: true, status: 200, json: async () => ({ id: "new-page" }) };
  };
  return { calls, fetch };
}

test("notion-projects: 같은 제목 페이지가 있으면 상태만 바꾼다", async () => {
  const f = fakeFetch("page-1");
  const r = await syncNotionProject("  기획서 쓰기 ", "doing", { conf, fetch: f.fetch, now: () => NOW });
  assert.deepEqual(r, { ok: true, action: "updated", pageId: "page-1" });
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].url, `${NOTION_API}/databases/db1/query`);
  assert.deepEqual(f.calls[0].body.filter, { property: NOTION_PROJECTS.titleProp, title: { equals: "기획서 쓰기" } });
  assert.equal(f.calls[1].method, "PATCH");
  assert.equal(f.calls[1].url, `${NOTION_API}/pages/page-1`);
  assert.deepEqual(f.calls[1].body, { properties: { 상태: { status: { name: "진행 중" } } } });
});

test("notion-projects: 없으면 작업명·날짜(오늘)·상태로 만든다. 시작·등록·완료일자는 쓰지 않는다", async () => {
  const f = fakeFetch(null);
  const r = await syncNotionProject("기획서 쓰기", "done", { conf, fetch: f.fetch, now: () => NOW });
  assert.deepEqual(r, { ok: true, action: "created", pageId: "new-page" });
  assert.equal(f.calls[1].method, "POST");
  assert.equal(f.calls[1].url, `${NOTION_API}/pages`);
  assert.deepEqual(f.calls[1].body, {
    parent: { database_id: "db1" },
    properties: {
      작업명: { title: [{ text: { content: "기획서 쓰기" } }] },
      날짜: { date: { start: "2026-11-04" } },
      상태: { status: { name: "완료" } },
    },
  });
});

test("notion-projects: 실패해도 던지지 않고 경고만, 설정이 없으면 부르지 않는다", async () => {
  const warns: string[] = [];
  const f = fakeFetch(null, { at: "/query", status: 401 });
  const r = await syncNotionProject("기획서 쓰기", "doing", { conf, fetch: f.fetch, warn: (m) => warns.push(m) });
  assert.equal(r.ok, false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /401/);
  assert.ok(!warns[0].includes("secret_test"));
  const thrown = await syncNotionProject("x", "done", { conf, fetch: async () => { throw new Error("network down"); }, warn: (m) => warns.push(m) });
  assert.equal(thrown.ok, false);
  assert.match(warns[1], /network down/);
  const g = fakeFetch("p");
  assert.deepEqual(await syncNotionProject("x", "doing", { conf: null, fetch: g.fetch }), { ok: false, skipped: true });
  assert.equal(g.calls.length, 0);
});

test("notion-projects: 설정은 환경변수가 먼저, 둘 다 있어야 켜진다", () => {
  assert.equal(notionProjectsConf({}, {}), null);
  assert.equal(notionProjectsConf({}, { notionProjects: { token: "", databaseId: "" } }), null);
  assert.equal(notionProjectsConf({ CY_AGENT_NOTION_TOKEN: "t" }, {}), null);
  assert.deepEqual(notionProjectsConf({ CY_AGENT_NOTION_TOKEN: "t" }, { notionProjects: { token: "f", databaseId: "d" } }), { token: "t", databaseId: "d" });
  assert.deepEqual(notionProjectsConf({ CY_AGENT_NOTION_TOKEN: "t", CY_AGENT_NOTION_PROJECTS_DB: "e" }, {}), { token: "t", databaseId: "e" });
});

test("notion-projects: ▶ 켜기 → 진행 중, 완료 → 완료. 노션이 실패해도 할 일은 그대로 바뀐다", async () => {
  const store = new Store(":memory:");
  const calls: [string, string][] = [];
  const agent = new Agent(loadConfig({}, {}), store, new Bus(), undefined, {
    useBroker: false,
    notionSync: async (title, state) => { calls.push([title, state]); throw new Error("notion down"); },
  });
  const t = agent.addTodo({ title: "기획서 쓰기" });
  assert.equal(agent.editTodo(t.id, { doing: true })?.doing, true);
  agent.editTodo(t.id, { doing: true }); // 이미 켜져 있으면 다시 안 부른다
  agent.editTodo(t.id, { priority: 2 }); // 상관없는 수정
  assert.equal(agent.editTodo(t.id, { status: "done" })?.status, "done");
  agent.editTodo(t.id, { status: "done" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["기획서 쓰기", "doing"], ["기획서 쓰기", "done"]]);
});

// 노션 페이지 모양(쿼리 결과 한 줄)
const page = (id: string, title: string, status: string) => ({
  id, url: `https://www.notion.so/${id}`,
  properties: { 작업명: { title: [{ plain_text: title }] }, 상태: { status: { name: status } } },
});

test("notion-projects: 오늘·완료 아닌 작업을 여러 쪽 넘겨 읽는다", async () => {
  const calls: Call[] = [];
  const pages = [
    { results: [page("p1", "기획서 쓰기", "할 일"), page("p2", "리뷰", "진행 중")], has_more: true, next_cursor: "c2" },
    { results: [page("p3", "끝난 것", "완료"), page("p4", "", "할 일")], has_more: false, next_cursor: null },
  ];
  const fetch = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ method: init.method, url, body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: true, status: 200, json: async () => pages[calls.length - 1] };
  };
  const r = await fetchTodayProjects({ conf, fetch, now: () => NOW });
  assert.deepEqual(r, { ok: true, tasks: [
    { pageId: "p1", title: "기획서 쓰기", state: "todo", url: "https://www.notion.so/p1" },
    { pageId: "p2", title: "리뷰", state: "doing", url: "https://www.notion.so/p2" },
  ] });
  assert.equal(calls[0].url, `${NOTION_API}/databases/db1/query`);
  assert.deepEqual(calls[0].body.filter, { and: [
    { property: "날짜", date: { equals: "2026-11-04" } },
    { property: "상태", status: { does_not_equal: "완료" } },
  ] });
  assert.equal(calls[0].body.start_cursor, undefined);
  assert.equal(calls[1].body.start_cursor, "c2");
  assert.deepEqual(await fetchTodayProjects({ conf: null, fetch }), { ok: false, skipped: true });
  const warns: string[] = [];
  const bad = await fetchTodayProjects({ conf, fetch: fakeFetch(null, { at: "/query", status: 401 }).fetch, warn: (m) => warns.push(m) });
  assert.equal(bad.ok, false);
  assert.match(warns[0], /401/);
});

test("notion-projects: 페이지 id 로 바로 상태를 바꾼다(검색·생성 없음)", async () => {
  const f = fakeFetch(null);
  assert.deepEqual(await setNotionProjectState("p1", "done", { conf, fetch: f.fetch }), { ok: true, action: "updated", pageId: "p1" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, "PATCH");
  assert.equal(f.calls[0].url, `${NOTION_API}/pages/p1`);
  assert.deepEqual(f.calls[0].body, { properties: { 상태: { status: { name: "완료" } } } });
});

test("notion-projects: 가져오기는 upsert — 새 건 P1, 다시 가져오면 제목·진행중만 맞춘다", () => {
  const store = new Store(":memory:");
  const r1 = applyNotionTasks(store, [
    { pageId: "p1", title: "기획서 쓰기", state: "todo", url: "https://www.notion.so/p1" },
    { pageId: "p2", title: "리뷰", state: "doing" },
  ]);
  assert.deepEqual(r1, { added: 2, updated: 0, unchanged: 0 });
  const a = store.todoBySourceRef("notion:p1")!.todo!;
  assert.equal(a.title, "기획서 쓰기");
  assert.equal(a.priority, 1);
  assert.equal(a.source, "notion");
  assert.equal(a.link, "https://www.notion.so/p1");
  assert.equal(a.doing, undefined);
  assert.equal(store.todoBySourceRef("notion:p2")!.todo!.doing, true);
  store.editTodo(a.id, { priority: 3 }); // 앱에서 바꾼 우선순위는 그대로 둔다
  const r2 = applyNotionTasks(store, [
    { pageId: "p1", title: "기획서 다시 쓰기", state: "doing" },
    { pageId: "p2", title: "리뷰", state: "todo" },
  ]);
  assert.deepEqual(r2, { added: 0, updated: 2, unchanged: 0 });
  assert.equal(store.openTodos().length, 2);
  const a2 = store.getTodo(a.id)!;
  assert.equal(a2.title, "기획서 다시 쓰기");
  assert.equal(a2.doing, true);
  assert.equal(a2.priority, 3);
  assert.equal(store.todoBySourceRef("notion:p2")!.todo!.doing, undefined);
  assert.deepEqual(applyNotionTasks(store, [{ pageId: "p2", title: "리뷰", state: "todo" }]), { added: 0, updated: 0, unchanged: 1 });
});

test("notion-projects: 앱에서 끝냈거나 지운 건 되살리지 않고, 같은 제목의 열린 할 일엔 붙인다", () => {
  const store = new Store(":memory:");
  applyNotionTasks(store, [{ pageId: "p1", title: "끝낸 일", state: "todo" }, { pageId: "p2", title: "지운 일", state: "todo" }]);
  store.editTodo(store.todoBySourceRef("notion:p1")!.todo!.id, { status: "done" });
  store.trashTodo(store.todoBySourceRef("notion:p2")!.todo!.id);
  const mine = store.addTodo({ title: "직접 만든 일" });
  const r = applyNotionTasks(store, [
    { pageId: "p1", title: "끝낸 일", state: "todo" },
    { pageId: "p2", title: "지운 일", state: "todo" },
    { pageId: "p3", title: "직접 만든 일", state: "doing", url: "https://www.notion.so/p3" },
  ]);
  assert.deepEqual(r, { added: 0, updated: 1, unchanged: 2 });
  assert.deepEqual(store.openTodos().map((t) => t.id), [mine.id]);
  const m = store.getTodo(mine.id)!;
  assert.equal(m.sourceRef, "notion:p3");
  assert.equal(m.link, "https://www.notion.so/p3");
  assert.equal(m.doing, true);
});

test("notion-projects: 가져온 할 일의 ▶·완료는 페이지 id 로, 앱에서 만든 할 일은 만든 페이지를 붙여 둔다", async () => {
  const store = new Store(":memory:");
  const calls: [string, string, string | undefined][] = [];
  const agent = new Agent(loadConfig({}, {}), store, new Bus(), undefined, {
    useBroker: false,
    notionSync: async (title, state, pageId) => { calls.push([title, state, pageId]); return { ok: true, action: pageId ? "updated" : "created", pageId: pageId ?? "made-1" }; },
    notionToday: async () => ({ ok: true, tasks: [{ pageId: "p1", title: "기획서 쓰기", state: "todo" }] }),
  });
  assert.deepEqual(await agent.importNotionToday(), { ok: true, added: 1, updated: 0, unchanged: 0 });
  const imported = store.todoBySourceRef("notion:p1")!.todo!;
  agent.editTodo(imported.id, { doing: true });
  agent.editTodo(imported.id, { status: "done" });
  const mine = agent.addTodo({ title: "직접 만든 일" });
  agent.editTodo(mine.id, { doing: true });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, [["기획서 쓰기", "doing", "p1"], ["기획서 쓰기", "done", "p1"], ["직접 만든 일", "doing", undefined]]);
  assert.equal(store.getTodo(mine.id)!.sourceRef, "notion:made-1");
  // 설정이 없으면 건너뛴다
  const off = new Agent(loadConfig({}, {}), new Store(":memory:"), new Bus(), undefined, { useBroker: false, notionToday: async () => ({ ok: false, skipped: true }) });
  assert.deepEqual(await off.importNotionToday(), { ok: false, skipped: true });
});

test("notion-projects: POST /todos/notion/import 로 수동 가져오기", async () => {
  const bus = new Bus();
  let n = 0;
  await bus.listen(0, {
    approve: async () => "", hold: async () => "", briefing: async () => "", dashboard: async () => ({ generatedAt: "t", projects: [] }),
    todoDone: () => true, chat: () => "c", chatHistory: () => [],
    todoNotionImport: async () => { n++; return { ok: true, added: 1, updated: 0, unchanged: 0 }; },
  });
  try {
    const url = `http://127.0.0.1:${(bus.server!.address() as any).port}/todos/notion/import`;
    assert.equal((await fetch(url, { method: "POST" })).status, 403); // CSRF 헤더 없음
    const r = await fetch(url, { method: "POST", headers: { "x-cy-agent": "1" } });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, added: 1, updated: 0, unchanged: 0 });
    assert.equal(n, 1);
  } finally { bus.close(); }
});
