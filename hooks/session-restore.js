#!/usr/bin/env node

/**
 * session-restore.js — SessionStart hook (직전 맥락 주입)
 *
 * 새 세션 시작 시 stdout으로 출력 → 새 세션 맨 앞 컨텍스트로 자동 주입.
 * 주입 내용(3종):
 *   ① 이어가기 요약  : <cwd>/sessions/summary/*.md  (가장 최신 1개 전체)
 *   ② 직전 위키 노트 : <cwd>/sessions/wiki/*.md      (INDEX 제외, 가장 최신 1개 본문 전체)
 *   ③ 위키 인덱스    : <cwd>/sessions/wiki/INDEX.md  (쌓인 지식 목록 — 한 줄 설명 포함)
 * 셋 다 없고 raw만 있으면 → 최신 raw 포인터.
 * 요약 frontmatter가 quality: degraded면 주입 시 품질 경고 한 줄을 함께 출력.
 * 주입 라벨(=== … ===)은 주입 내용의 언어를 따라간다 — 한글 있으면 한국어, 없으면 영어.
 *
 * source=clear 면 주입 생략. CLAUDE_WIKI_CHILD(위키 워커 자식)면 생략.
 * 절대 차단하지 않음(exit 0).
 */

const fs = require('fs');
const path = require('path');
const { sessionsAnchor } = require('./lib-project-dir');

// 파일 앞부분만 읽는다(대용량 transcript 전체 읽기 회피).
function readHead(fp, n) {
  let fd;
  try {
    fd = fs.openSync(fp, 'r');
    const b = Buffer.alloc(n);
    const bytes = fs.readSync(fd, b, 0, n, 0);
    return b.slice(0, bytes).toString('utf8');
  } catch (e) { return ''; }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch (e) {} } }
}

// 안전망: SessionEnd 미발화(/exit 실패·크래시·백그라운드작업 중 종료)로 원본 보존·요약이 안 된 직전 세션을
// SessionStart에서 자동 복구한다.
//   ★ 게이트: 먼저 내용을 읽지 않고 'stat'만으로 "새 미저장 세션이 있는지" 싸게 판정한다. 정상 종료라
//     직전 세션이 이미 raw/summary에 저장돼 있으면 → 여기서 즉시 반환(전체 스캔·256KB 읽기 안 함).
//   실제로 미저장 세션이 감지될 때만(=실패 경로) 전체 스캔을 돌려:
//     (1) sessions/raw 에 원본 복사(멱등) — 원본은 절대 유실되지 않는다.
//     (2) 그중 '요약 안 된 가장 최근 1개'를 워커로 증류 트리거 → 다음 세션 시작 시 요약 주입.
// 절대 throw 하지 않는다(세션 시작 방해 금지). 증류 트리거한 orphan을 반환, 없으면 null.
function backfillOrphans(projectDir, currentSid) {
  try {
    const sdir = path.join(projectDir, 'sessions');
    const summaryDir = path.join(sdir, 'summary');
    const rawDir = path.join(sdir, 'raw');
    const projectsRoot = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude', 'projects');
    if (!fs.existsSync(projectsRoot)) return null;
    const now = Date.now();
    const MAXAGE = 72 * 3600 * 1000;
    const IN_PROGRESS_MS = 180000; // 최근 3분 내 수정된 트랜스크립트는 '진행중 라이브'로 보고 증류 보류(라이브 조기 증류 방지). (2026-06-26)
    const MAX_DEGRADED_RETRIES = 2; // degraded-only 세션 재증류 상한(무한루프 방지) — 워커와 동일.
    const curLc = currentSid ? String(currentSid).toLowerCase() : '';
    // 라이브 판정 보강: 서브에이전트·긴 명령 대기 중엔 본 transcript가 수십 분 안 바뀐다 → mtime 3분 기준만으론
    //   살아 있는 세션을 orphan으로 오인해 조기 증류했다(2026-09-25 23afef61 실측: transcript 11:24 정지, 훅은 11:37까지 발화).
    //   hook-logger가 매 훅마다 쓰는 hooks_<sid>.log가 최근 15분 내 갱신됐고 마지막 이벤트가 SessionEnd가 아니면 라이브로 본다.
    const LIVE_HOOK_MS = 15 * 60 * 1000;
    const hookDir = path.join(require('os').tmpdir(), 'claude-statusline');
    const liveByHooks = (sid) => {
      try {
        const fp = path.join(hookDir, `hooks_${String(sid).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80)}.log`);
        const st = fs.statSync(fp);
        if (now - st.mtimeMs > LIVE_HOOK_MS) return false;
        const fd = fs.openSync(fp, 'r'); const n = Math.min(st.size, 512); const b = Buffer.alloc(n);
        try { fs.readSync(fd, b, 0, n, st.size - n); } finally { fs.closeSync(fd); }
        const last = b.toString('utf8').trim().split('\n').pop() || '';
        return !/\tSessionEnd\b/.test(last);
      } catch (e) { return false; }
    };
    const sidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

    // 요약 분류: 정상 요약된 sid(properlySummarized) vs degraded-only sid(아직 제대로 저장 안 됨).
    // degraded 파일만 있는 세션은 재증류 대상(상한까지) — degraded를 "요약됨"으로 보던 고착 버그 해제. (2026-06-26)
    const properlySummarized = new Set();
    const degradedRetries = new Map(); // sid → 최대 distill_retries
    const latestSummaryMtime = new Map(); // sid → 정상 요약 중 가장 최근 mtime (PreCompact 스냅샷 이후 raw 갱신 감지용)
    for (const d of [summaryDir, path.join(summaryDir, '_archive')]) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) {
        const m = f.match(sidRe); if (!m || !f.endsWith('.md')) continue;
        const sidLc = m[0].toLowerCase();
        const full = path.join(d, f);
        let txt = ''; try { txt = fs.readFileSync(full, 'utf8'); } catch (e) {}
        // ★ frontmatter 블록만 검사 — 본문이 "quality: degraded"를 언급해도(이 주제처럼) 오판 금지.
        const fmM = txt.match(/^---\n([\s\S]*?)\n---/);
        const fm = fmM ? fmM[1] : '';
        if (/^quality:\s*degraded/m.test(fm)) {
          const r = fm.match(/^distill_retries:\s*(\d+)/m);
          const n = r ? parseInt(r[1], 10) : 0;
          degradedRetries.set(sidLc, Math.max(degradedRetries.get(sidLc) || 0, n));
        } else {
          properlySummarized.add(sidLc); // 정상 요약 1개라도 있으면 완료로 본다
          try { const mt = fs.statSync(full).mtimeMs; latestSummaryMtime.set(sidLc, Math.max(latestSummaryMtime.get(sidLc) || 0, mt)); } catch (e) {}
        }
      }
    }
    const degradedRetryable = new Set(); // 재증류해볼 degraded-only sid (정상본 없음 + 상한 미달)
    for (const [sidLc, n] of degradedRetries) {
      if (!properlySummarized.has(sidLc) && n < MAX_DEGRADED_RETRIES) degradedRetryable.add(sidLc);
    }

    // ── 싼 게이트 (stat만, 내용 안 읽음) ──
    // 이 git 루트의 프로젝트 dir만 본다: C:\Dev\SAAH → "C--Dev-SAAH" 및 그 하위(C--Dev-SAAH-*).
    // Claude Code는 경로의 영숫자 외 문자를 '각각' '-'로 치환(연속도 collapse 안 함)하므로 동일 규칙으로 인코딩한다.
    const encodedRoot = projectDir.replace(/[^a-zA-Z0-9]/g, '-');
    const matchDir = (n) => n === encodedRoot || n.startsWith(encodedRoot + '-');
    const candDirs = [];
    let newestTx = 0; // 현재 세션·진행중 라이브 제외, 최근 transcript의 최신 mtime
    for (const pd of fs.readdirSync(projectsRoot)) {
      if (!matchDir(pd)) continue;
      const dir = path.join(projectsRoot, pd);
      let dst; try { dst = fs.statSync(dir); } catch { continue; }
      if (!dst.isDirectory()) continue;
      candDirs.push(dir);
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        if (curLc && f.slice(0, -6).toLowerCase() === curLc) continue;
        let st; try { st = fs.statSync(path.join(dir, f)); } catch { continue; }
        if (now - st.mtimeMs > MAXAGE) continue;
        if (now - st.mtimeMs < IN_PROGRESS_MS) continue; // 진행중 라이브 — 게이트 계산서 제외(조기 증류 방지)
        if (liveByHooks(f.slice(0, -6))) continue; // 훅이 아직 발화 중인 라이브 세션
        if (st.mtimeMs > newestTx) newestTx = st.mtimeMs;
      }
    }
    // raw는 있는데 요약이 한 번도 안 된 세션(증류 실패 orphan) — 파일명 sid만 비교(내용 안 읽음).
    //   구 게이트는 "최신 transcript mtime vs 최신 raw/summary mtime"만 봐서, orphan 뒤에 다른 세션이 하나라도
    //   정상 저장되면 그 orphan을 영영 재시도하지 않았다(2026-09-24 23:17 7cd535a3 유실 사고). (2026-09-25)
    // 시도 장부 — 워커가 sid마다 시도 횟수를 센다. 상한 도달 sid는 게이트·후보에서 뺀다(무한 재증류 방지).
    //   비대상(단발·워커 자식)으로 판정된 raw도 여기에 상한값으로 기록해 매 시작마다 전체 스캔을 다시 돌지 않게 한다.
    const MAX_ATTEMPTS = 4;
    const attemptsFile = path.join(sdir, '.distill-attempts.json');
    let attempts = {}; try { attempts = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')) || {}; } catch (e) {}
    let attemptsDirty = false;
    const exhausted = (sidLc) => (attempts[sidLc] || 0) >= MAX_ATTEMPTS;
    const unsummarizedRaw = new Set();
    if (fs.existsSync(rawDir)) {
      for (const f of fs.readdirSync(rawDir)) {
        const m = f.match(sidRe); if (!m || !f.endsWith('.jsonl')) continue;
        const sidLc = m[0].toLowerCase();
        if (sidLc === curLc || properlySummarized.has(sidLc) || degradedRetries.has(sidLc)) continue; // degraded는 degradedRetryable이 담당
        if (exhausted(sidLc)) continue; // 시도 상한 도달 또는 비대상 판정
        let st; try { st = fs.statSync(path.join(rawDir, f)); } catch { continue; }
        if (now - st.mtimeMs > MAXAGE) continue;
        unsummarizedRaw.add(sidLc);
      }
    }
    if (!newestTx && degradedRetryable.size === 0 && unsummarizedRaw.size === 0) return null; // 최근 후보·재증류 대상 없음
    let newestSaved = 0; // 이미 저장된(raw/summary) 최신 mtime
    for (const d of [rawDir, summaryDir]) {
      if (!fs.existsSync(d)) continue;
      for (const f of fs.readdirSync(d)) { let st; try { st = fs.statSync(path.join(d, f)); } catch { continue; } if (st.mtimeMs > newestSaved) newestSaved = st.mtimeMs; }
    }
    if (newestTx <= newestSaved && degradedRetryable.size === 0 && unsummarizedRaw.size === 0) return null; // 정상 — 새 미저장·재증류·orphan 없음 → 전체 스캔 생략

    // ── 여기부터는 미저장/재증류 세션이 감지됐을 때만 (실패 경로) ──
    const distilling = fs.existsSync(path.join(sdir, '.distilling')); // 증류 중이면 신규 증류만 보류(raw 복사는 계속)
    const ts = (ms) => { const n = new Date(ms); const p = x => String(x).padStart(2, '0'); return `${n.getFullYear()}_${p(n.getMonth() + 1)}_${p(n.getDate())}__${p(n.getHours())}.${p(n.getMinutes())}`; };
    const rawSaved = new Set();
    if (fs.existsSync(rawDir)) for (const f of fs.readdirSync(rawDir)) { const m = f.match(sidRe); if (m) rawSaved.add(m[0].toLowerCase()); }
    const norm = (p) => { try { return path.resolve(p).replace(/\\/g, '/').toLowerCase(); } catch (e) { return String(p).toLowerCase(); } };
    const pdNorm = norm(projectDir);
    let best = null;
    for (const dir of candDirs) {
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const sid = f.slice(0, -6); const sidLc = sid.toLowerCase();
        if (curLc && sidLc === curLc) continue; // 현재 세션 제외(미완)
        const fp = path.join(dir, f);
        let fst; try { fst = fs.statSync(fp); } catch { continue; }
        if (now - fst.mtimeMs > MAXAGE) continue;
        if ((now - fst.mtimeMs) < IN_PROGRESS_MS) continue; // 진행중 라이브 세션 — raw 복사·증류 모두 보류(조기 증류 방지)
        if (liveByHooks(sid)) continue; // 훅 발화 중 = 라이브(서브에이전트·긴 명령 대기) — 보류
        // 앞부분(256KB)만 읽어 cwd + 인터랙티브(user≥2) 판정
        const head = readHead(fp, 262144);
        let cwd = '', users = 0, workerChild = false;
        for (const ln of head.split('\n')) {
          const s = ln.trim(); if (!s) continue;
          let o; try { o = JSON.parse(s); } catch { continue; }
          if (!cwd && o.cwd) cwd = o.cwd;
          if (o.type === 'user') {
            // 증류 워커가 띄운 claude 자식 세션(첫 user = 증류 프롬프트)은 사용자 세션이 아니다 — raw 복사·증류 제외.
            //   도구 호출이 섞이면 user≥2가 돼 예전엔 orphan으로 오인됐다(3b554e94). (2026-09-25)
            if (users === 0) { const c = o.message && o.message.content; const t = typeof c === 'string' ? c : (Array.isArray(c) ? c.map(x => (x && x.text) || '').join('') : ''); if (/^The following input is a Claude Code session transcript/.test(t.trim())) workerChild = true; }
            users++;
          }
        }
        if (!cwd || users < 2 || workerChild) { // 짧은 단발/워커/서브에이전트 세션 제외
          if (!exhausted(sidLc)) { attempts[sidLc] = MAX_ATTEMPTS; attemptsDirty = true; } // 비대상 확정 — 다음부터 게이트서 제외
          continue;
        }
        if (norm(sessionsAnchor(cwd)) !== pdNorm) continue; // 이 앵커 소속만(정규화 비교)
        // (1) raw 원본 복사 — 멱등(이미 있으면 스킵)
        if (!rawSaved.has(sidLc)) {
          try {
            if (!fs.existsSync(rawDir)) fs.mkdirSync(rawDir, { recursive: true });
            fs.copyFileSync(fp, path.join(rawDir, `${ts(fst.mtimeMs)}_${sid}.jsonl`));
            rawSaved.add(sidLc);
          } catch (e) {}
        }
        // (2) 증류 후보 — 정상 요약이 없거나, 있어도 그보다 raw가 더 최신(=PreCompact 스냅샷 이후 세션이
        //     더 진행되다 크래시)이면 재증류 대상. degraded-only는 상한 미달이면 재증류 포함.
        const hasDegraded = degradedRetries.has(sidLc);
        const summaryStale = properlySummarized.has(sidLc) && (latestSummaryMtime.get(sidLc) || 0) < fst.mtimeMs - 60000;
        const eligible = (!properlySummarized.has(sidLc) || summaryStale) && (!hasDegraded || degradedRetryable.has(sidLc));
        if (eligible && !exhausted(sidLc) && (!best || fst.mtimeMs > best.mtime)) best = { fp, sid, mtime: fst.mtimeMs };
      }
    }
    if (attemptsDirty) { try { fs.writeFileSync(attemptsFile, JSON.stringify(attempts)); } catch (e) {} }
    if (distilling || !best) return null; // 증류 중이거나 미요약 고아 없음 — raw 보존만 하고 종료
    if (!fs.existsSync(sdir)) fs.mkdirSync(sdir, { recursive: true });
    fs.writeFileSync(path.join(sdir, '.distilling'), String(now));
    const worker = path.join(__dirname, 'wiki-distill-worker.js');
    const child = require('child_process').spawn(process.execPath, [worker, best.fp, projectDir, best.sid], {
      detached: true, stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CLAUDE_WIKI_CHILD: '1' }
    });
    child.unref();
    return best;
  } catch (e) { return null; }
}

let buf = '';
let done = false;

function finish() {
  if (done) return;
  done = true;
  try {
    if (process.env.CLAUDE_WIKI_CHILD) return process.exit(0); // 위키 워커가 띄운 세션 — 주입 안 함

    let d = {};
    try { d = JSON.parse(buf || '{}'); } catch {}

    const source = d.source || 'startup';
    if (source === 'clear') return process.exit(0); // 의도적 초기화 — 주입 생략
    if (source === 'resume') return process.exit(0); // resume은 Claude Code가 그 세션 전체를 네이티브 로드 — 중복/오염 주입 금지

    const cwd = d.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    // 하위 폴더(예: SAAH/guide)에서 켜도 git 루트 한 곳에서 읽는다 — 저장 훅과 동일 기준. (PO 지시 2026-06-26)
    const projectDir = sessionsAnchor(cwd);
    const sessionsDir = path.join(projectDir, 'sessions');

    // ── source=compact : 방금 컴팩션이 끝난 '같은 세션'의 재개 ── (2026-09-09)
    // 여기서 평소의 '직전 세션 요약 + 위키 + 인덱스'를 주입하면 안 된다:
    //   ① 그건 남의 세션 얘기라 지금 작업과 무관 — 오염
    //   ② 방금 컴팩션으로 비운 컨텍스트를 도로 채우는 꼴 — 컴팩션 무력화
    // 대신 PreCompact가 방금 만든 '이 세션의' 핸드오프만 주입한다.
    if (source === 'compact') {
      try {
        const sid = String(d.session_id || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);
        const cf = path.join(sessionsDir, 'compact', `${sid}_핸드오프.md`);
        if (sid && fs.existsSync(cf)) {
          const body = fs.readFileSync(cf, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
          if (body) {
            console.log('=== 컴팩트 직전 작업 상태 (자동 주입) ===\n' + body +
              '\n---\n(위 내용은 방금 압축된 대화의 핸드오프입니다. 같은 세션의 연속 작업이니 이어서 진행하세요.)');
          }
        }
      } catch (e) {}
      return process.exit(0); // 백필·직전세션 주입 경로로는 절대 내려가지 않는다
    }

    // 안전망: 직전 세션이 SessionEnd 미발화로 요약 안 됐으면 여기서 자동 증류 트리거(백필). (PO 지시 2026-06-26)
    const backfilled = backfillOrphans(projectDir, d.session_id);
    const summaryDir = path.join(sessionsDir, 'summary');
    const wikiDir = path.join(sessionsDir, 'wiki');

    // 현재 작업 줄기(git 브랜치) — 같은 브랜치에서 일하던 세션을 우선 이어간다(시각 아님).
    // cwd가 저장소 하위 폴더(예: SAAH/guide)일 수 있으므로 .git을 찾을 때까지 상위로 거슬러 올라간다.
    const currentBranch = (startDir) => {
      try {
        let dir = startDir;
        for (let i = 0; i < 30; i++) {
          const gitPath = path.join(dir, '.git');
          if (fs.existsSync(gitPath)) {
            const st = fs.statSync(gitPath);
            let gitDir = null;
            if (st.isDirectory()) gitDir = gitPath;
            else { // worktree: .git는 'gitdir: <경로>' 파일
              const m = fs.readFileSync(gitPath, 'utf8').match(/gitdir:\s*(.+)/);
              if (m) gitDir = path.resolve(dir, m[1].trim());
            }
            if (gitDir) {
              const headFile = path.join(gitDir, 'HEAD');
              if (fs.existsSync(headFile)) {
                const h = fs.readFileSync(headFile, 'utf8').trim();
                const rm = h.match(/ref:\s*refs\/heads\/(.+)/);
                return rm ? rm[1].trim() : h.slice(0, 8);
              }
            }
          }
          const parent = path.dirname(dir);
          if (parent === dir) break; // 파일시스템 루트 도달
          dir = parent;
        }
      } catch (e) {}
      return '';
    };
    // 요약/위키 frontmatter에서 git_branch, session_id, 제목, degraded 여부 추출
    const metaOf = (full) => {
      let branch = '', sid = '', title = '', degraded = false;
      try {
        const txt = fs.readFileSync(full, 'utf8');
        const fm = txt.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const b = fm[1].match(/^git_branch:\s*(.+)$/m); if (b) branch = b[1].trim();
          const s = fm[1].match(/^session_id:\s*(.+)$/m); if (s) sid = s[1].trim();
          if (/^quality:\s*degraded/m.test(fm[1])) degraded = true;
        }
        const t = txt.match(/^#\s+(.+)$/m); if (t) title = t[1].trim();
      } catch (e) {}
      // 폴백: frontmatter에 session_id가 없는 구버전 요약은 파일명에 박힌 UUID에서 추출
      if (!sid) { const m = path.basename(full).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) sid = m[0]; }
      return { branch, sid, title, degraded };
    };
    const listMd = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .map(f => { const full = path.join(dir, f); return { f, full, m: fs.statSync(full).mtimeMs, ...metaOf(full) }; })
        .sort((a, b) => b.m - a.m);
    };

    const branch = currentBranch(cwd);

    // 정상(non-degraded) 우선 선택기: 같은 브랜치 정상 최신 → 정상 최신 → 같은 브랜치 최신 → 전체 최신.
    // degraded뿐일 때만 degraded를 주입(그땐 품질 경고 한 줄이 함께 나간다). (2026-06-26)
    const pick = (list) =>
      (branch && list.find(x => x.branch === branch && !x.degraded)) ||
      list.find(x => !x.degraded) ||
      (branch && list.find(x => x.branch === branch)) ||
      list[0] || null;

    // 요약: 정상 같은 브랜치 최신 우선 (구버전 요약엔 branch 태그가 없어 폴백)
    const sums = listMd(summaryDir);
    const pickSum = pick(sums);
    const summaryBody = pickSum ? fs.readFileSync(pickSum.full, 'utf8').trim() : '';

    // 위키: 정상 같은 브랜치 최신 우선
    const wikis = listMd(wikiDir);
    const pickWiki = pick(wikis);
    let wikiBody = pickWiki ? fs.readFileSync(pickWiki.full, 'utf8').trim() : '';
    let indexBody = '';
    const indexFile = path.join(wikiDir, 'INDEX.md');
    if (fs.existsSync(indexFile)) {
      // 주입은 최근 항목만 (파일 자체는 전체 이력 보존). 오래된 것은 INDEX.md 직접 참조.
      const INDEX_KEEP = 8;
      const raw = fs.readFileSync(indexFile, 'utf8').trim();
      const lines = raw.split('\n');
      const title = lines.find(l => l.startsWith('#')) || '# 위키 인덱스';
      const bullets = lines.filter(l => l.trim().startsWith('- '));
      const kept = bullets.slice(0, INDEX_KEEP);
      const omitted = bullets.length - kept.length;
      indexBody = [title, '', ...kept].join('\n');
      if (omitted > 0) indexBody += `\n- … (오래된 ${omitted}개 생략 — sessions/wiki/INDEX.md 직접 참조)`;
    }

    // 안전망: 같은 디렉토리의 다른 최근 세션 목록(주입된 것 제외) — 다른 걸 이어가려면 PO가 지목.
    const others = sums.filter(x => !pickSum || x.f !== pickSum.f).slice(0, 5);

    // ── 신선도 검사 ──
    // 사고: SessionEnd 증류는 비동기 워커(통상 60~120초)다. 그게 끝나기 전에 새 세션을 열면
    //   그 시점의 '가장 최신 요약'은 직전 세션이 아니라 전전 세션 것이고, 새 세션은 그걸 직전으로 믿는다.
    //   실측(2026-08-16): 종료 16:21:46 → 새 세션 시작 16:22:12 → 요약 저장 16:23:09. 47초 차이로 오주입.
    // 대응: 막지 않고(시작 지연 금지) 경고를 맨 앞에 붙여, 요약을 '직전'으로 단정하지 못하게 한다.
    // 감지 둘 — (1) .distilling 마커 = 증류 진행 중, (2) raw가 최신 요약보다 새로움 = 증류 실패/미완.
    const staleness = (() => {
      try {
        const pickMs = pickSum ? pickSum.m : 0;
        let inflight = false;
        const marker = path.join(sessionsDir, '.distilling');
        if (fs.existsSync(marker)) {
          try { inflight = (Date.now() - fs.statSync(marker).mtimeMs) < 30 * 60 * 1000; } catch (e) {}
        }
        let newestRaw = null;
        const rd = path.join(sessionsDir, 'raw');
        if (fs.existsSync(rd)) {
          for (const f of fs.readdirSync(rd)) {
            if (!f.endsWith('.jsonl')) continue;
            let st; try { st = fs.statSync(path.join(rd, f)); } catch (e) { continue; }
            if (!newestRaw || st.mtimeMs > newestRaw.m) newestRaw = { fp: path.join(rd, f), m: st.mtimeMs };
          }
        }
        // 60초 여유 — 요약이 raw보다 조금 늦게 쓰이는 정상 순서를 오탐하지 않는다.
        const rawNewer = !!(newestRaw && newestRaw.m > pickMs + 60000);
        if (!inflight && !rawNewer) return null;
        return { raw: newestRaw ? newestRaw.fp : '' };
      } catch (e) { return null; }
    })();

    // 라벨 언어는 '주입 내용'의 언어를 따라간다 — 한글이 있으면 한국어, 없으면 영어.
    const ko = /[가-힣]/.test(summaryBody || wikiBody || indexBody || '');
    const L = ko ? {
      summary: '=== 직전 세션 이어가기 요약 (자동 주입) ===',
      degraded: '(주의: 이 요약은 자동증류 품질이 낮음 — sessions/raw 원본 확인 권장)',
      wiki: '=== 직전 세션 위키 노트 (자동 주입) ===',
      index: '=== 위키 인덱스 (필요한 항목만 펼쳐 읽으세요) ===',
      recent: '=== 같은 디렉토리 최근 세션 (다른 걸 이어가려면 지목하세요) ===',
      footer: '(이어서 작업하려면 위 요약을 참고하고, 더 깊은 맥락은 위키 항목이나 sessions/raw 원본을 필요한 만큼만 읽으세요.)',
      rawHead: '=== 직전 세션 원본 있음 (아직 요약/위키 없음) ===',
      rawBody: '이어서 작업하려면 필요한 부분만 읽으세요: ',
      backfillHead: '=== 직전 세션이 정상 저장되지 않아 자동 복구를 시작했습니다 (완료 시 다음 세션부터 요약 주입) ===',
      backfillBody: '지금 바로 직전 맥락이 필요하면 원본을 필요한 만큼만 읽으세요: ',
      staleHead: '=== ⚠ 경고: 직전 세션 요약이 아직 준비되지 않았습니다 — 아래 주입된 요약은 "직전"이 아닐 수 있습니다 ===',
      staleBody: '직전 세션 증류가 진행 중이거나 실패했습니다. 아래 요약을 직전 세션으로 단정하지 말고, sessions/summary/ 와 sessions/wiki/ 의 파일 목록을 직접 확인해 더 최신 파일이 있는지 보세요(증류는 보통 1~2분 내 완료). 직전 세션 원본: '
    } : {
      summary: '=== Previous session handoff summary (auto-injected) ===',
      degraded: '(Note: this summary was auto-distilled at low quality — check the sessions/raw original.)',
      wiki: '=== Previous session wiki note (auto-injected) ===',
      index: '=== Wiki index (expand only what you need) ===',
      recent: '=== Other recent sessions in this directory (name one to continue it instead) ===',
      footer: '(To continue, use the summary above; read the wiki notes or sessions/raw originals only as needed.)',
      rawHead: '=== Previous session raw transcript available (no summary/wiki yet) ===',
      rawBody: 'Read only the parts you need to continue: ',
      backfillHead: '=== Previous session was not saved cleanly — auto-recovery started (its summary injects from next start) ===',
      backfillBody: 'If you need the previous context right now, read only what you need from the original: ',
      staleHead: '=== ⚠ WARNING: the previous session\'s summary is not ready yet — the summary injected below may NOT be the previous session ===',
      staleBody: 'Distillation is still running or failed. Do not assume the summary below is the previous session; list sessions/summary/ and sessions/wiki/ yourself to check for a newer file (distillation usually finishes within 1-2 minutes). Previous session raw transcript: '
    };

    const out = [];
    if (summaryBody) {
      out.push(L.summary);
      if (/^quality:\s*degraded/m.test(summaryBody)) out.push(L.degraded);
      out.push(summaryBody);
    }
    if (wikiBody) { out.push(''); out.push(L.wiki); out.push(wikiBody); }
    if (indexBody) { out.push(''); out.push(L.index); out.push(indexBody); }
    if (summaryBody && others.length) {
      out.push('');
      out.push(L.recent);
      for (const o of others) {
        const id = (o.sid || '').slice(0, 8) || '????????';
        const br = o.branch && o.branch !== 'unknown' ? ` (${o.branch})` : '';
        out.push(`- [${id}] ${o.title || o.f}${br}`);
      }
    }

    // 백필을 트리거했으면 복구 알림을 맨 앞에 덧붙인다 (요약이 있든 없든).
    if (backfilled) {
      out.unshift(L.backfillBody + backfilled.fp);
      out.unshift(L.backfillHead);
    }

    // 신선도 경고는 가장 위 — 아래 요약을 읽기 전에 먼저 보이게 한다.
    if (staleness) {
      out.unshift(L.staleBody + (staleness.raw || 'sessions/raw/'));
      out.unshift(L.staleHead);
    }

    if (out.length) {
      out.push('---');
      out.push(L.footer);
      console.log(out.join('\n'));
      return process.exit(0);
    }

    // 폴백: 요약·위키 없고 raw만 있으면 최신 원본 포인터 (내용 없어 언어 판정 불가 → 기본 영어)
    const rawDir = path.join(sessionsDir, 'raw');
    if (fs.existsSync(rawDir)) {
      const files = fs.readdirSync(rawDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, m: fs.statSync(path.join(rawDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) {
        console.log(L.rawHead);
        console.log(L.rawBody + path.join(rawDir, files[0].f));
      }
    }
  } catch (e) {
    // 주입 실패는 조용히 무시 (세션 시작 방해 금지)
  }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', finish);
setTimeout(finish, 1500);
