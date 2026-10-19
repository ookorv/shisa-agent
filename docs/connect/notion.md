# Notion 연결

노션 문서도 로컬에 모아 두지 않습니다. 채팅할 때 모델이 노션 공식 MCP의 읽기 도구로 페이지를 검색하고 읽습니다.

| 모드 | 어떻게 읽나 |
|---|---|
| `mcp` | Claude Code에 등록한 노션 MCP(Claude Code 뇌일 때만 읽힙니다) |
| `off` | 노션 MCP 서버를 쓰지 않습니다. 등록돼 있어도 도구·리소스(`notion://`)가 막힙니다 |

역할은 `search`(검색)와 `read`(페이지·데이터베이스 하나 읽기)입니다. 쓰기 도구(페이지 생성·수정·이동·삭제, 댓글 등)는 매핑에 적어도 허용되지 않습니다.

## 1) 등록

노션 공식 원격 서버([developers.notion.com/docs/mcp](https://developers.notion.com/docs/mcp))를 사용자 범위로 등록합니다.

```bash
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
```

그다음 대화형 Claude Code에서 `/mcp`를 열고 `notion` → **Authenticate**를 눌러 브라우저에서 노션 워크스페이스 접근을 허락합니다.

## 2) 설정

`~/.cy-agent/config.json`:

```json
{ "connectors": { "notion": { "mode": "mcp", "server": "notion" } } }
```

이렇게 하면 노션 서버의 도구 중 이름이 읽기인 것(`notion-search`·`notion-fetch`·`notion-get-users` 등)만 쓰입니다.
검색·읽기 두 도구로만 좁히려면 프리셋을 씁니다.

```json
{ "connectors": { "notion": { "mode": "mcp", "preset": "notion" } } }
```

| 역할 | 도구 |
|---|---|
| search | `notion-search` |
| read | `notion-fetch` |

## 끊기

패널의 [연결 해제]를 누르거나 `connectors.notion`을 `"off"`로 바꿉니다. 서버 등록까지 지우려면 `claude mcp remove notion`을 실행합니다.
