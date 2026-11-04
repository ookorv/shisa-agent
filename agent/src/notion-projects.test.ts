import { test } from "node:test";
import assert from "node:assert/strict";
import { NOTION_API, NOTION_PROJECTS, notionProjectsConf, syncNotionProject } from "./notion-projects.ts";
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
