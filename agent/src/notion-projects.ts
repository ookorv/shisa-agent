// 노션 Projects 데이터베이스(Daisy > Projects) 상태 맞추기: 할 일에서 ▶(진행중)을 켜면 「진행 중」, 완료하면 「완료」.
// 노션에서 가져온 할 일(sourceRef notion:<id>)은 그 페이지 상태만 바꾸고, 앱에서 만든 할 일은 제목이 같은 페이지를 찾아
// 상태만 바꾸거나 없으면 새로 만든다(작업명 = 제목, 날짜 = 오늘, 상태 — 만든 페이지 id 는 할 일에 붙여 둔다). 시작일자·등록일자·완료일자는
// 노션 자동화가 채우므로 쓰지 않는다. 노션 공식 REST API(내부 통합 토큰)를 직접 부른다 — 커넥터(connectors.ts)의 MCP 는 읽기만 한다.
//
// 설정(비밀값은 코드에 두지 않는다): 환경변수 CY_AGENT_NOTION_TOKEN · CY_AGENT_NOTION_PROJECTS_DB,
// 또는 ~/.cy-agent/config.json 의 { "notionProjects": { "token": "", "databaseId": "" } }. 둘 다 비면 아무것도 안 한다.
// 실패·미연결이어도 할 일 시작·완료는 그대로 — 경고 로그만 남긴다(syncNotionProject 는 던지지 않는다).
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripBom } from "./fs-atomic.ts";
import { localDay } from "./focus.ts";
import type { Store } from "./store.ts";

// 노션 속성 이름·옵션 값(데이터베이스에서 이름을 바꾸면 여기만 고친다)
export const NOTION_PROJECTS = {
  titleProp: "작업명",
  dateProp: "날짜",
  statusProp: "상태",
  statusType: "status", // 노션 「상태」 속성. 선택(select) 속성이면 "select"
  options: { todo: "할 일", doing: "진행 중", done: "완료" },
} as const;
export type ProjectState = keyof typeof NOTION_PROJECTS.options;

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2022-06-28";

export type NotionProjectsConf = { token: string; databaseId: string };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json(): Promise<any> }>;
export type SyncDeps = { conf?: NotionProjectsConf | null; fetch?: Fetch; now?: () => number; warn?: (msg: string) => void };
export type SyncResult = { ok: true; action: "updated" | "created"; pageId: string } | { ok: false; skipped?: true; error?: string };

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);

function readFile(): Record<string, any> {
  try { return JSON.parse(stripBom(readFileSync(join(process.env.CY_AGENT_HOME ?? join(homedir(), ".cy-agent"), "config.json"), "utf8"))); } catch { return {}; }
}

// 토큰·DB id 가 둘 다 있어야 켜진다(환경변수가 config.json 보다 먼저)
export function notionProjectsConf(env: NodeJS.ProcessEnv = process.env, file: Record<string, any> = readFile()): NotionProjectsConf | null {
  const c = file.notionProjects && typeof file.notionProjects === "object" ? file.notionProjects : {};
  const token = str(env.CY_AGENT_NOTION_TOKEN) ?? str(c.token);
  const databaseId = str(env.CY_AGENT_NOTION_PROJECTS_DB) ?? str(c.databaseId);
  return token && databaseId ? { token, databaseId } : null;
}

const statusValue = (name: string) => ({ [NOTION_PROJECTS.statusType]: { name } });

// 노션 API 한 번 부르기(실패면 상태 코드·메시지로 던진다 — 토큰은 메시지에 안 넣는다)
function notionCall(conf: NotionProjectsConf, deps: SyncDeps) {
  const f: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const headers = { Authorization: `Bearer ${conf.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
  return async (method: string, path: string, body: unknown) => {
    const r = await f(`${NOTION_API}${path}`, { method, headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${j?.code ?? ""} ${j?.message ?? ""}`.trim());
    return j;
  };
}

// 제목으로 찾기 → 있으면 상태 바꾸기, 없으면 만들기. 던지지 않는다
export async function syncNotionProject(title: string, state: ProjectState, deps: SyncDeps = {}): Promise<SyncResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const name = title.trim();
  const conf = deps.conf === undefined ? notionProjectsConf() : deps.conf;
  if (!conf || !name) return { ok: false, skipped: true };
  const call = notionCall(conf, deps);
  const status = NOTION_PROJECTS.options[state];
  try {
    const q = await call("POST", `/databases/${conf.databaseId}/query`, { filter: { property: NOTION_PROJECTS.titleProp, title: { equals: name } }, page_size: 1 });
    const hit = q?.results?.[0]?.id as string | undefined;
    if (hit) {
      await call("PATCH", `/pages/${hit}`, { properties: { [NOTION_PROJECTS.statusProp]: statusValue(status) } });
      return { ok: true, action: "updated", pageId: hit };
    }
    const made = await call("POST", "/pages", {
      parent: { database_id: conf.databaseId },
      properties: {
        [NOTION_PROJECTS.titleProp]: { title: [{ text: { content: name } }] },
        [NOTION_PROJECTS.dateProp]: { date: { start: localDay((deps.now ?? Date.now)()) } },
        [NOTION_PROJECTS.statusProp]: statusValue(status),
      },
    });
    return { ok: true, action: "created", pageId: String(made?.id ?? "") };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 200);
    warn(`[notion-projects] 「${name}」 상태(${status}) 맞추기 실패: ${error}`);
    return { ok: false, error };
  }
}

// ---- 노션 → 앱: 오늘(날짜) 작업 중 「완료」가 아닌 것을 할 일로 가져오기(노션이 원본) ----
// 가져온 할 일은 sourceRef = notion:<페이지 id>, link = 페이지 주소. 다시 가져오면 새로 만들지 않고 제목·(진행중)만 맞춘다.
// 그 할 일의 ▶·완료는 저장된 페이지 id 로 바로 상태를 바꾼다(제목 검색·새 페이지 만들기 없음 — core.editTodo).
export const NOTION_REF = "notion:";
export const notionPageId = (sourceRef?: string) => (sourceRef?.startsWith(NOTION_REF) ? sourceRef.slice(NOTION_REF.length) || undefined : undefined);

export type NotionTask = { pageId: string; title: string; state: "todo" | "doing"; url?: string };
export type FetchTodayResult = { ok: true; tasks: NotionTask[] } | { ok: false; skipped?: true; error?: string };
export type ImportResult = { ok: true; added: number; updated: number; unchanged: number } | { ok: false; skipped?: true; error?: string };

// 오늘 날짜이고 상태가 「완료」가 아닌 페이지(여러 쪽이면 다 넘겨 읽는다). 던지지 않는다
export async function fetchTodayProjects(deps: SyncDeps = {}): Promise<FetchTodayResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const conf = deps.conf === undefined ? notionProjectsConf() : deps.conf;
  if (!conf) return { ok: false, skipped: true };
  const call = notionCall(conf, deps);
  const filter = { and: [
    { property: NOTION_PROJECTS.dateProp, date: { equals: localDay((deps.now ?? Date.now)()) } },
    { property: NOTION_PROJECTS.statusProp, [NOTION_PROJECTS.statusType]: { does_not_equal: NOTION_PROJECTS.options.done } },
  ] };
  try {
    const tasks: NotionTask[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 10; i++) { // 100개씩 최대 10쪽
      const q = await call("POST", `/databases/${conf.databaseId}/query`, { filter, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
      for (const p of q?.results ?? []) {
        const props = p?.properties ?? {};
        const title = (props[NOTION_PROJECTS.titleProp]?.title ?? []).map((t: any) => t?.plain_text ?? t?.text?.content ?? "").join("").trim();
        const status = props[NOTION_PROJECTS.statusProp]?.[NOTION_PROJECTS.statusType]?.name;
        if (!p?.id || !title || status === NOTION_PROJECTS.options.done) continue;
        tasks.push({ pageId: String(p.id), title, state: status === NOTION_PROJECTS.options.doing ? "doing" : "todo", ...(typeof p.url === "string" ? { url: p.url } : {}) });
      }
      if (!q?.has_more || !q?.next_cursor) break;
      cursor = String(q.next_cursor);
    }
    return { ok: true, tasks };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 200);
    warn(`[notion-projects] 오늘 작업 가져오기 실패: ${error}`);
    return { ok: false, error };
  }
}

// 가져온 할 일의 상태만 바꾸기(페이지 id 로 바로). 던지지 않는다
export async function setNotionProjectState(pageId: string, state: ProjectState, deps: SyncDeps = {}): Promise<SyncResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const conf = deps.conf === undefined ? notionProjectsConf() : deps.conf;
  if (!conf || !pageId) return { ok: false, skipped: true };
  const status = NOTION_PROJECTS.options[state];
  try {
    await notionCall(conf, deps)("PATCH", `/pages/${pageId}`, { properties: { [NOTION_PROJECTS.statusProp]: statusValue(status) } });
    return { ok: true, action: "updated", pageId };
  } catch (e: any) {
    const error = String(e?.message ?? e).slice(0, 200);
    warn(`[notion-projects] 페이지 ${pageId} 상태(${status}) 바꾸기 실패: ${error}`);
    return { ok: false, error };
  }
}

// 노션 작업 → 앱 할 일 upsert. 찾는 순서: 같은 페이지 id(sourceRef) → 같은 제목의 열린 할 일(노션에 직접 만들어 둔 것과 겹치지 않게).
// 새 할 일은 우선순위 1(오늘 꼭). 이미 있으면 제목·(진행중)만 맞춘다 — 우선순위·메모는 그대로.
// 앱에서 끝냈거나 휴지통에 넣은 할 일은 되살리지 않는다(앱에서 끝낸 건 완료로 노션에 이미 보냈다)
export function applyNotionTasks(store: Store, tasks: NotionTask[]): { added: number; updated: number; unchanged: number } {
  let added = 0, updated = 0, unchanged = 0;
  const open = store.openTodos();
  for (const t of tasks) {
    const ref = `${NOTION_REF}${t.pageId}`;
    const hit = store.todoBySourceRef(ref);
    if (hit && (hit.trashed || hit.todo?.status !== "open")) { unchanged++; continue; }
    let cur = hit?.todo ?? open.find((o) => !notionPageId(o.sourceRef) && o.title.trim() === t.title);
    if (!cur) {
      const made = store.addTodo({ title: t.title, priority: 1, source: "notion", sourceRef: ref, ...(t.url ? { link: t.url } : {}) }, "auto");
      if (t.state === "doing") store.syncTodo(made.id, { doing: true });
      added++;
      continue;
    }
    if (!cur.sourceRef) { store.linkTodoSource(cur.id, ref, t.url); cur = store.getTodo(cur.id) ?? cur; }
    // 진행 중 → (진행중) 켬, 할 일 → 켜져 있던 것만 끔(자동으로). 껐던 것(false)은 그대로
    const doing = t.state === "doing" ? true : cur.doing === true ? null : cur.doing;
    if (store.syncTodo(cur.id, { title: t.title, doing })) updated++; else unchanged++;
  }
  return { added, updated, unchanged };
}
