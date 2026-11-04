// 노션 Projects 데이터베이스(Daisy > Projects) 상태 맞추기: 할 일에서 ▶(진행중)을 켜면 「진행 중」, 완료하면 「완료」.
// 제목이 같은 페이지를 찾아 상태만 바꾸고, 없으면 새로 만든다(작업명 = 제목, 날짜 = 오늘, 상태). 시작일자·등록일자·완료일자는
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

// 제목으로 찾기 → 있으면 상태 바꾸기, 없으면 만들기. 던지지 않는다
export async function syncNotionProject(title: string, state: ProjectState, deps: SyncDeps = {}): Promise<SyncResult> {
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  const name = title.trim();
  const conf = deps.conf === undefined ? notionProjectsConf() : deps.conf;
  if (!conf || !name) return { ok: false, skipped: true };
  const f: Fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  const headers = { Authorization: `Bearer ${conf.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" };
  const call = async (method: string, path: string, body: unknown) => {
    const r = await f(`${NOTION_API}${path}`, { method, headers, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${r.status} ${j?.code ?? ""} ${j?.message ?? ""}`.trim());
    return j;
  };
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
