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
    const sessionsDir = path.join(cwd, 'sessions');
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
    // 요약/위키 frontmatter에서 git_branch, session_id, 제목 추출
    const metaOf = (full) => {
      let branch = '', sid = '', title = '';
      try {
        const txt = fs.readFileSync(full, 'utf8');
        const fm = txt.match(/^---\n([\s\S]*?)\n---/);
        if (fm) {
          const b = fm[1].match(/^git_branch:\s*(.+)$/m); if (b) branch = b[1].trim();
          const s = fm[1].match(/^session_id:\s*(.+)$/m); if (s) sid = s[1].trim();
        }
        const t = txt.match(/^#\s+(.+)$/m); if (t) title = t[1].trim();
      } catch (e) {}
      // 폴백: frontmatter에 session_id가 없는 구버전 요약은 파일명에 박힌 UUID에서 추출
      if (!sid) { const m = path.basename(full).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i); if (m) sid = m[0]; }
      return { branch, sid, title };
    };
    const listMd = (dir) => {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .map(f => { const full = path.join(dir, f); return { f, full, m: fs.statSync(full).mtimeMs, ...metaOf(full) }; })
        .sort((a, b) => b.m - a.m);
    };

    const branch = currentBranch(cwd);

    // 요약: 같은 브랜치 최신 우선 → 없으면 전체 최신 (구버전 요약엔 branch 태그가 없어 폴백)
    const sums = listMd(summaryDir);
    const pickSum = (branch && sums.find(x => x.branch === branch)) || sums[0] || null;
    const summaryBody = pickSum ? fs.readFileSync(pickSum.full, 'utf8').trim() : '';

    // 위키: 같은 브랜치 최신 우선 → 없으면 전체 최신
    const wikis = listMd(wikiDir);
    const pickWiki = (branch && wikis.find(x => x.branch === branch)) || wikis[0] || null;
    let wikiBody = pickWiki ? fs.readFileSync(pickWiki.full, 'utf8').trim() : '';
    let indexBody = '';
    const indexFile = path.join(wikiDir, 'INDEX.md');
    if (fs.existsSync(indexFile)) indexBody = fs.readFileSync(indexFile, 'utf8').trim();

    // 안전망: 같은 디렉토리의 다른 최근 세션 목록(주입된 것 제외) — 다른 걸 이어가려면 PO가 지목.
    const others = sums.filter(x => !pickSum || x.f !== pickSum.f).slice(0, 5);

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
      rawBody: '이어서 작업하려면 필요한 부분만 읽으세요: '
    } : {
      summary: '=== Previous session handoff summary (auto-injected) ===',
      degraded: '(Note: this summary was auto-distilled at low quality — check the sessions/raw original.)',
      wiki: '=== Previous session wiki note (auto-injected) ===',
      index: '=== Wiki index (expand only what you need) ===',
      recent: '=== Other recent sessions in this directory (name one to continue it instead) ===',
      footer: '(To continue, use the summary above; read the wiki notes or sessions/raw originals only as needed.)',
      rawHead: '=== Previous session raw transcript available (no summary/wiki yet) ===',
      rawBody: 'Read only the parts you need to continue: '
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
