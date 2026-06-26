#!/usr/bin/env node

/**
 * wiki-distill-worker.js — 백그라운드 증류 워커 (요약 + 위키 동시 생성)
 *
 * session-to-wiki.js(SessionEnd 훅)가 detached로 띄운다.
 * 방금 끝난 세션 원본(.jsonl)을 "가볍게" 읽어(최근 24,000자) Sonnet(claude-sonnet-4-6)
 * 한 번 호출로 세 가지를 만든다:
 *   ① 이어가기 요약 → <cwd>/sessions/summary/<ts>_<sid>_요약.md  (새 세션이 읽고 복구, 누적)
 *   ② 위키 노트(지식 + [[링크]]) → <cwd>/sessions/wiki/<ts>_<sid>_위키.md  (옵시디언에 누적)
 *   ③ 위키 인덱스 → <cwd>/sessions/wiki/INDEX.md  (한 줄 설명, 최신이 맨 위)
 *
 * 보강:
 *  - 품질 자기검증: 마커 부족·빈 출력·타임아웃이면 1회만 재시도, 그래도 실패면 폴백 +
 *    summary/wiki frontmatter에 quality: degraded / degraded_reason 기록.
 *  - 요약 retention: summary/는 최신 SUMMARY_KEEP개만 두고 나머지는 summary/_archive/로 이동(무손실).
 *  - INDEX 정합성: 갱신 시 실제 파일 없는 [[링크]](ghost) 제거, 미색인 파일(orphan)은 로그만.
 *
 * 인증: 잘못된 ANTHROPIC_API_KEY 제거 후 OAuth 사용.
 * 재귀 방지: claude 자식에 CLAUDE_WIKI_CHILD=1 → 그 세션의 훅들은 건너뛴다.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 인프라 실패(구독 한도 소진·인증 오류 등)는 '내용 요약 실패'가 아니라 '일시적 장애'다.
// 이 출력을 요약으로 저장하면 안 된다 — orphan으로 남겨 한도 회복 후 백필이 재증류한다. (2026-06-26 하드닝)
const INFRA_RE = /weekly limit|usage limit|session limit|hit your .{0,20}limit|rate limit|Invalid API key|Fix external API key|insufficient.{0,10}credit|connectors are disabled|Not logged in|Please run \/login/i;
const MAX_DEGRADED_RETRIES = 2; // degraded 재증류 상한(백필 무한루프 방지). 같은 sid가 이 횟수까지 실패하면 포기.
const isInfraError = (t) => !!t && INFRA_RE.test(t);

const SUMMARY_KEEP = 10; // summary/ 최신 유지 개수 (나머지는 _archive/로 이동)

const transcript = process.argv[2];
const cwd = process.argv[3];
const sid = (process.argv[4] || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);

const sessionsDir = path.join(cwd, 'sessions');
const wikiDir = path.join(sessionsDir, 'wiki');       // 위키 노트(지식) 누적
const summaryDir = path.join(sessionsDir, 'summary'); // 이어가기 요약 누적 (덮어쓰지 않음)
const logFile = path.join(sessionsDir, '.wiki-distill.log');
const markerPath = path.join(sessionsDir, '.distilling');
// 워커가 어떤 경로로 끝나든(성공/폴백/에러/타임아웃) 진행중 마커를 제거 → cloop이 재접속 진행.
process.on('exit', () => { try { fs.unlinkSync(markerPath); } catch (e) {} });

function log(m) {
  try {
    if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${m}\n`);
  } catch (e) {}
}
const pad = x => String(x).padStart(2, '0');
function ts() { const n = new Date(); return `${n.getFullYear()}_${pad(n.getMonth() + 1)}_${pad(n.getDate())}__${pad(n.getHours())}.${pad(n.getMinutes())}`; }

function extractConvo() {
  let text = '';
  try {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n');
    for (const ln of lines) {
      const s = ln.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch (e) { continue; }
      const msg = o.message || o;
      const role = msg.role || o.type;
      if (role !== 'user' && role !== 'assistant') continue;
      const c = msg.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c)) t = c.filter(x => x && x.type === 'text').map(x => x.text).join('\n');
      t = (t || '').trim();
      if (t) text += `[${role}] ${t}\n`;
    }
  } catch (e) { log('extract 실패: ' + e.message); }
  return text.slice(-32000); // 가볍게(최근 우선): 최근 32,000자 — 엑시트 직전 내용 상세화를 위해 창 확대
}

// '작업 중이던 그 세션'만 증류 (요건 2). 워크플로/서브에이전트/wiki-worker 세션은 건너뜀.
// 마이두 환경에서 진짜 대화도 entrypoint='sdk-cli' → entrypoint 기준 사용 불가.
// user 메시지 수 ≥ 2 로 판별: wiki-worker·서브에이전트는 user 1개(거대 프롬프트 1회).
function isInteractiveSession(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    let userCount = 0;
    for (const ln of lines) {
      const s = ln.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.type === 'user') userCount++;
      if (userCount >= 2) return true;
    }
    return false;
  } catch { return true; }
}

// 세션 연결고리: 트랜스크립트에 박힌 gitBranch 추출 (작업 줄기 식별용).
function extractGitBranch() {
  try {
    const lines = fs.readFileSync(transcript, 'utf8').split('\n');
    for (const ln of lines) {
      const s = ln.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.gitBranch) return String(o.gitBranch);
    }
  } catch (e) {}
  return '';
}

function main() {
  if (!transcript || !fs.existsSync(transcript)) { log('transcript 없음: ' + transcript); return; }
  if (!isInteractiveSession(transcript)) { log('비인터랙티브(워크플로/서브에이전트/SDK) 세션 — 증류 건너뜀'); return; }
  if (!fs.existsSync(wikiDir)) fs.mkdirSync(wikiDir, { recursive: true });
  if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir, { recursive: true });

  const convo = extractConvo();
  if (!convo.trim()) { log('대화 텍스트 없음 — 건너뜀'); return; }

  const project = path.basename(cwd);
  const gitBranch = extractGitBranch(); // 세션 연결고리 — 복원 시 같은 브랜치(작업 줄기) 우선 선택
  // 한 번의 호출로 세 섹션 출력 (마커로 구분). 프롬프트는 한 줄(cmd 안전).
  // 출력 언어는 전사록의 주 언어를 따른다(한국어 세션→한국어, 영어 세션→영어 …). 메타 지시는 언어중립(영어).
  const PROMPT = "The following input is a Claude Code session transcript, ordered oldest to newest. First detect the transcript's main language, then write ALL of your output in that same language. Output only three parts. (1) A line containing only @@@TITLE@@@ , then below it a one-line title compressing this session (about 40 characters or fewer). (2) A line containing only @@@HANDOFF@@@ , then below it a handoff summary with three sections meaning: What was done / Current state / Next steps. CRITICAL REQUIREMENT: the MOST RECENT work, right before the session ended, is the highest priority — describe it in DETAIL, naming the exact files and paths touched, commands run, decisions made, and the precise current state (what is done, what is half-done, what comes next), so the next session can resume without re-investigating. Older work may be summarized in one or two lines, but the recent work section must be specific and may be long. Never compress away recent details. (3) A line containing only @@@WIKI@@@ , then below it a knowledge note that organizes this session's key knowledge, decisions and artifacts by topic, marking related concepts as [[title]] wikilinks. Each of the three markers must be alone on its own line. No preamble or explanation, output only the three parts.";
  const cmd = `claude -p "${PROMPT}" --model claude-sonnet-4-6 --dangerously-skip-permissions`;

  const env = { ...process.env, CLAUDE_WIKI_CHILD: '1' };
  delete env.ANTHROPIC_API_KEY; // 잘못된 키 제거 → OAuth 사용

  // Sonnet 1회 호출 → cb(full출력문자열, timedOut)
  function callClaude(cb) {
    let out = '', err = '', timedOut = false;
    const ch = spawn(cmd, { shell: true, env, windowsHide: true });
    ch.stdout.on('data', d => out += d.toString());
    ch.stderr.on('data', d => err += d.toString());
    const killer = setTimeout(() => { timedOut = true; try { ch.kill(); } catch (e) {} log('타임아웃 150s'); }, 150000);
    ch.on('error', e => { clearTimeout(killer); log('spawn 오류: ' + e.message); cb('', timedOut); });
    ch.on('close', code => {
      clearTimeout(killer);
      const full = (out || '').trim();
      if (!full) log('빈 출력 (code ' + code + '), stderr: ' + err.slice(0, 300));
      cb(full, timedOut);
    });
    ch.stdin.write(convo);
    ch.stdin.end();
  }

  // 마커 파싱 — 마커는 '한 줄에 단독'인 경우만 인정(본문 속 언급과 충돌 방지)
  function parse(full) {
    const lines = full.split('\n');
    const ti = lines.findIndex(l => l.trim() === '@@@TITLE@@@');
    const hi = lines.findIndex(l => l.trim() === '@@@HANDOFF@@@');
    const wi = lines.findIndex(l => l.trim() === '@@@WIKI@@@');
    if (hi >= 0 && wi >= 0) {
      return {
        ok: true,
        title: lines.slice(ti >= 0 ? ti + 1 : 0, hi).join(' ').trim(),
        summary: lines.slice(hi + 1, wi).join('\n').trim(),
        wiki: lines.slice(wi + 1).join('\n').trim()
      };
    }
    return { ok: false };
  }

  // 같은 sid의 옛 degraded 산출물(summary/wiki)을 찾는다. retries 카운터 계승·중복 제거에 사용.
  // 반환: { files: [경로...], maxRetries: 지금까지 최대 distill_retries }
  function priorDegraded(theSid) {
    const files = [], dirs = [summaryDir, wikiDir];
    let maxRetries = 0;
    for (const d of dirs) {
      let names; try { names = fs.readdirSync(d); } catch { continue; }
      for (const f of names) {
        if (!f.includes(theSid) || !f.endsWith('.md')) continue;
        const fp = path.join(d, f);
        let txt; try { txt = fs.readFileSync(fp, 'utf8'); } catch { continue; }
        // ★ frontmatter 블록만 검사 — 본문이 "quality: degraded"를 언급해도 오판 금지.
        const fmM = txt.match(/^---\n([\s\S]*?)\n---/); const fm = fmM ? fmM[1] : '';
        if (!/^quality:\s*degraded/m.test(fm)) continue; // degraded만 대상(정상본은 보존)
        const m = fm.match(/^distill_retries:\s*(\d+)/m);
        if (m) maxRetries = Math.max(maxRetries, parseInt(m[1], 10));
        files.push(fp);
      }
    }
    return { files, maxRetries };
  }

  // 산출물 쓰기 — degradedReason이 truthy면 frontmatter에 품질 저하 + 재시도 횟수 기록.
  // 어느 경우든(정상/저하) 같은 sid의 옛 degraded 파일은 제거 → 누적·고착 방지.
  function writeOut(p, degradedReason) {
    let title = p.title, summary = p.summary, wiki = p.wiki;
    if (!title) title = project;
    const dateIso = new Date().toISOString();
    const stamp = ts();
    const prior = priorDegraded(sid);
    const retries = degradedReason ? prior.maxRetries + 1 : 0; // 이번에도 실패면 카운트 +1
    const qLines = degradedReason ? `quality: degraded\ndegraded_reason: ${degradedReason}\ndistill_retries: ${retries}\n` : '';
    try {
      // ① 이어가기 요약 → summary 폴더에 누적(매번 새 파일, 덮어쓰지 않음)
      const linkLines = `session_id: ${sid}\ngit_branch: ${gitBranch || 'unknown'}\n`; // 세션 연결고리
      const summaryNote = `---\ndate: ${dateIso}\nproject: ${project}\ntype: handoff-summary\nsource: auto (SessionEnd / Sonnet)\n${linkLines}${qLines}---\n\n# ${title} (${stamp})\n\n${summary}\n`;
      fs.writeFileSync(path.join(summaryDir, `${stamp}_${sid}_요약.md`), summaryNote, 'utf8');
      // 정상본을 새로 썼거나 degraded를 갱신했으면 같은 sid의 옛 degraded는 제거(자기 자신 제외).
      const selfSum = path.join(summaryDir, `${stamp}_${sid}_요약.md`);
      for (const fp of prior.files) { if (fp !== selfSum) { try { fs.unlinkSync(fp); } catch (e) {} } }
      log('이어가기 요약 저장(summary/ 누적)' + (degradedReason ? ` [degraded: ${degradedReason} · 재시도 ${retries}/${MAX_DEGRADED_RETRIES}]` : '') + (prior.files.length ? ` · 옛 degraded ${prior.files.length}건 정리` : ''));

      // ② 위키 노트 → wiki 폴더에 누적
      const wikiBase = `${stamp}_${sid}_위키`;
      const wikiNote = `---\ndate: ${dateIso}\nproject: ${project}\ntype: session-wiki\nsource: auto (SessionEnd / Sonnet)\n${linkLines}${qLines}tags: [wiki, ${project}]\n---\n\n# ${title}\n\n${wiki}\n`;
      fs.writeFileSync(path.join(wikiDir, wikiBase + '.md'), wikiNote, 'utf8');
      log('위키 노트 작성: ' + wikiBase);

      updateIndex(wikiBase, title); // ③ INDEX 갱신 + ghost 정리
      pruneSummaries(SUMMARY_KEEP); // 요약 retention
    } catch (e) { log('쓰기 실패: ' + e.message); }
  }

  // ③ 위키 인덱스(INDEX.md) 갱신 — 한 줄 추가(최신 맨 위) + ghost-link 제거 + orphan 로그
  function updateIndex(wikiBase, title) {
    const indexFile = path.join(wikiDir, 'INDEX.md');
    let entries = [];
    try { if (fs.existsSync(indexFile)) entries = fs.readFileSync(indexFile, 'utf8').split('\n').filter(l => l.startsWith('- ')); } catch (e) {}
    entries.unshift(`- [[${wikiBase}]] — ${title.replace(/\s+/g, ' ').trim()}`);
    // ghost-link 제거: [[파일]]이 실제 wiki/에 없으면 INDEX에서 뺀다 (링크 없는 줄은 보존)
    const before = entries.length;
    entries = entries.filter(l => {
      const m = l.match(/\[\[([^\]]+)\]\]/);
      if (!m) return true;
      return fs.existsSync(path.join(wikiDir, m[1] + '.md'));
    });
    if (entries.length !== before) log(`INDEX ghost-link ${before - entries.length}건 제거`);
    // orphan(파일 있으나 미색인) 로그만
    try {
      const indexed = new Set(entries.map(l => { const m = l.match(/\[\[([^\]]+)\]\]/); return m ? m[1] : null; }).filter(Boolean));
      const orphans = fs.readdirSync(wikiDir)
        .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .map(f => f.replace(/\.md$/, ''))
        .filter(n => !indexed.has(n));
      if (orphans.length) log(`INDEX orphan ${orphans.length}건(파일 있으나 미색인): ${orphans.slice(0, 5).join(', ')}`);
    } catch (e) {}
    fs.writeFileSync(indexFile, '# 위키 인덱스\n\n' + entries.join('\n') + '\n', 'utf8');
    log('INDEX.md 갱신');
  }

  // 요약 retention — 최신 keep개만 남기고 나머지는 _archive/로 이동(삭제 아님)
  function pruneSummaries(keep) {
    try {
      const files = fs.readdirSync(summaryDir).filter(f => f.endsWith('.md'))
        .map(f => ({ f, m: fs.statSync(path.join(summaryDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length <= keep) return;
      const archiveDir = path.join(summaryDir, '_archive');
      if (!fs.existsSync(archiveDir)) fs.mkdirSync(archiveDir, { recursive: true });
      let moved = 0;
      for (const { f } of files.slice(keep)) {
        try { fs.renameSync(path.join(summaryDir, f), path.join(archiveDir, f)); moved++; } catch (e) {}
      }
      if (moved) log(`요약 retention: 최신 ${keep}개 유지, ${moved}개 _archive/ 이동`);
    } catch (e) { log('retention 실패(무시): ' + e.message); }
  }

  // 오케스트레이션: 1차 호출 → 실패(마커없음·빈출력·타임아웃) 시 1회만 재시도 → 폴백(degraded)
  // ★ 인프라 에러(한도/인증)는 어느 단계든 감지 즉시 저장 보류(orphan 유지) → 한도 회복 후 백필이 재증류.
  log('claude(Sonnet) 호출 시작 (입력 ' + convo.length + '자)');
  callClaude((full1, to1) => {
    if (full1) {
      const p1 = parse(full1);
      if (p1.ok) return writeOut(p1, null); // 마커 정상 = 진짜 요약 → 내용 불문 저장(인프라검사는 마커없을 때만)
    }
    log('1차 실패(' + (full1 ? '마커없음' : (to1 ? '타임아웃' : '빈출력')) + ') — 1회 재시도');
    callClaude((full2, to2) => {
      const best = full2 || full1; // 재시도 출력 우선, 없으면 1차 출력 재활용
      if (best) {
        const p2 = parse(best);
        if (p2.ok) { log('재시도 성공'); return writeOut(p2, null); }
        // 마커 없음 → 진짜 산출 실패. 인프라 에러(한도/인증) 시그니처면 저장 보류(orphan 유지) → 한도 회복 후 백필 재시도.
        if (isInfraError(best)) { log('인프라 에러 감지(한도/인증) — 저장 보류, orphan 유지(백필 재시도): ' + best.slice(0, 80).replace(/\n/g, ' ')); return; }
        const body = best.replace(/@@@\w+@@@/g, '').trim(); // 인프라 아님 + 마커 없음 → 폴백 + degraded
        return writeOut({ title: '', summary: body, wiki: body }, '마커없음');
      }
      log('재시도도 산출 없음(' + (to2 ? '타임아웃' : '빈출력') + ') — 생성 건너뜀');
    });
  });
}
main();
