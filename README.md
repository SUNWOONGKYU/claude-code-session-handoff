# Claude Code Session Handoff — 컴팩트 대신 "저장 → 종료 → 재접속 → 복구"

> AI와 길게 작업할 때 컨텍스트가 가득 차 느려지는 문제를, **컴팩트(압축) 대신
> 기억을 파일로 저장하고 가볍게 새 세션으로 다시 시작**하는 방식으로 해결합니다.
> Claude Code의 `SessionEnd` / `SessionStart` 훅 + 슬래시 명령 + 재접속 래퍼로 구성.

**English TL;DR** — Instead of letting Claude Code *compact* (summarize-in-place, slow & lossy)
a full context, this setup **saves the session to disk on exit and re-injects a light summary
on the next start**. Result: context stays light, memory is never lost, and each restart costs
minimal tokens. Built from `SessionEnd` + `SessionStart` hooks, a `/마무리` slash command, and a
PowerShell auto-reconnect loop (`cloop`).

![flow](docs/flow.png)

---

## 왜?

Claude Code를 오래 쓰면 컨텍스트(대화 기억)가 가득 차고, 자동 컴팩트가 돌면 **느리고
중요한 디테일이 뭉개집니다.** 그래서 발상을 뒤집습니다 — 압축하지 말고, **기억을 밖에
저장한 뒤 가볍게 새로 시작**하자.

## 동작 흐름

1. 대화가 무거워지면 → **`/마무리`** : 살아있는 세션이 "한 장 요약"을 `sessions/raw/`와
   `sessions/LATEST.md`에 저장 (맥락을 이미 들고 있어 추가 토큰 거의 없음).
2. **`/exit`** 로 종료 → **`SessionEnd` 훅**(`session-save-raw.js`)이 대화 원본 `.jsonl`을
   `sessions/raw/`에 자동 백업 (안전망).
3. **`cloop`** 래퍼가 새 세션을 자동 재실행.
4. **`SessionStart` 훅**(`session-restore.js`)이 `LATEST.md`를 새 세션 첫머리에 자동 주입 →
   AI가 직전 맥락을 적은 토큰으로 즉시 복구.
5. **쌓인 요약은 옵시디언(Obsidian) 위키로 흡수** → 세션 노트가 위키링크로 연결되어
   '검색·연결되는 프로젝트 지식 베이스'로 성장 (옵신 / Obsidian ADOPT 등).

| 효과 | 설명 |
|---|---|
| ⚡ 빠름 | 컨텍스트를 항상 가볍게 유지 |
| 💾 기억 보존 | 모든 세션이 파일로 저장 |
| 💰 비용 절감 | 재시작 때 요약만 읽음 |
| 🧠 지식 축적 | 쌓인 요약이 옵시디언 위키로 연결 |

### `/마무리` vs `/exit` — 무엇을 저장하나 (꼭 구분)

| 구분 | `/마무리` (명령) | `/exit` (종료 → SessionEnd 훅) |
|---|---|---|
| 누가 | 살아있는 AI(모델) | 셸 스크립트(훅) 자동 |
| 무엇을 | **요약** 저장 | **대화록 원본** 저장 |
| 결과물 | `요약.md` + `LATEST.md` | `원본.jsonl` |
| 성격 | 똑똑한 증류(압축) | 통째 백업(안전망) |

`/마무리`는 원본을 건드리지 않습니다. 원본 백업은 `/exit`(SessionEnd 훅)이 담당합니다.

자세한 설명은 [`docs/세션훅_설명서.md`](docs/세션훅_설명서.md) 참고.

---

## 설치 (Windows + PowerShell 기준)

> Node.js가 PATH에 있어야 합니다(`node`). 경로의 `사용자명` 부분은 본인 환경에 맞게 바꾸세요.

### 1) 훅 스크립트 배치
`hooks/session-save-raw.js`, `hooks/session-restore.js` 를
`C:\Users\<사용자명>\.claude\hooks\` 에 복사.

### 2) settings.json 등록
`C:\Users\<사용자명>\.claude\settings.json` 의 `"hooks"` 에
[`settings.example.json`](settings.example.json) 의 `SessionStart` / `SessionEnd` 블록을 병합.

### 3) `/마무리` 명령 배치
`commands/마무리.md` 를 `C:\Users\<사용자명>\.claude\commands\` 에 복사.
(원하면 영어 이름 `wrapup.md` 등으로 바꿔도 됨.)

### 4) 재접속 래퍼(`cloop`) 등록
`powershell/profile-snippet.ps1` 의 `cloop` 함수를 PowerShell 프로필
(`$PROFILE.CurrentUserAllHosts`, 보통 `Documents\WindowsPowerShell\profile.ps1`)에 추가.
새 PowerShell 창부터 적용됩니다.

---

## 사용법

```text
1) 프로젝트 폴더에서:  cloop
2) 작업하다 무거워지면:  /마무리      (요약 저장)
3) 나가기:  /exit                      (SessionEnd가 원본 저장)
4) 자동으로 새 세션 → SessionStart가 요약 주입 → 이어서 작업
5) 완전히 끝낼 때:  /exit 후 5초 안에  q
```

- 세션 나가기: `/exit` 또는 `/quit` (Ctrl+D 대체)
- 루프 종료: 종료 후 5초 안에 `q` (Ctrl+C 대체)

## 저장 위치

```text
<프로젝트>\sessions\
  ├─ raw\        ← 대화 원본(.jsonl) + /마무리 요약(.md)
  └─ LATEST.md   ← 최신 요약 (SessionStart가 읽어 주입)
```

---

## 참고 / 한계

- 컴팩트 경고가 *뜨는 순간* 자체는 훅으로 잡을 수 없습니다(순수 UI). 그래서 트리거는
  사용자가 `/마무리` → `/exit` 를 치는 것입니다.
- 훅은 셸 스크립트라 **요약(증류)을 직접 못 합니다.** 똑똑한 요약은 살아있는 세션이
  `/마무리`로 만들고, 훅은 원본 보존(SessionEnd)과 주입(SessionStart)을 담당합니다.
- macOS/Linux는 `cloop`을 bash/zsh 함수로, 경로를 `~/.claude/...`로 바꾸면 동일하게 동작합니다.

## License

MIT — see [LICENSE](LICENSE).
