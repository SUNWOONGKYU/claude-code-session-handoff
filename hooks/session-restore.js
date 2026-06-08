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

    const cwd = d.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionsDir = path.join(cwd, 'sessions');
    const summaryDir = path.join(sessionsDir, 'summary');
    const wikiDir = path.join(sessionsDir, 'wiki');

    const newestIn = (dir, ext) => {
      if (!fs.existsSync(dir)) return null;
      const fl = fs.readdirSync(dir).filter(f => f.endsWith(ext))
        .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      return fl.length ? path.join(dir, fl[0].f) : null;
    };

    // 주입 내용 먼저 읽기 (요약 최신 1개 / 위키 최신 1개 / INDEX)
    const latestSummary = newestIn(summaryDir, '.md');
    const summaryBody = latestSummary ? fs.readFileSync(latestSummary, 'utf8').trim() : '';

    let wikiBody = '', indexBody = '';
    if (fs.existsSync(wikiDir)) {
      const notes = fs.readdirSync(wikiDir)
        .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .map(f => ({ f, m: fs.statSync(path.join(wikiDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (notes.length) wikiBody = fs.readFileSync(path.join(wikiDir, notes[0].f), 'utf8').trim();
      const indexFile = path.join(wikiDir, 'INDEX.md');
      if (fs.existsSync(indexFile)) indexBody = fs.readFileSync(indexFile, 'utf8').trim();
    }

    // 라벨 언어는 '주입 내용'의 언어를 따라간다 — 한글이 있으면 한국어, 없으면 영어.
    const ko = /[가-힣]/.test(summaryBody || wikiBody || indexBody || '');
    const L = ko ? {
      summary: '=== 직전 세션 이어가기 요약 (자동 주입) ===',
      degraded: '(주의: 이 요약은 자동증류 품질이 낮음 — sessions/raw 원본 확인 권장)',
      wiki: '=== 직전 세션 위키 노트 (자동 주입) ===',
      index: '=== 위키 인덱스 (필요한 항목만 펼쳐 읽으세요) ===',
      footer: '(이어서 작업하려면 위 요약을 참고하고, 더 깊은 맥락은 위키 항목이나 sessions/raw 원본을 필요한 만큼만 읽으세요.)',
      rawHead: '=== 직전 세션 원본 있음 (아직 요약/위키 없음) ===',
      rawBody: '이어서 작업하려면 필요한 부분만 읽으세요: '
    } : {
      summary: '=== Previous session handoff summary (auto-injected) ===',
      degraded: '(Note: this summary was auto-distilled at low quality — check the sessions/raw original.)',
      wiki: '=== Previous session wiki note (auto-injected) ===',
      index: '=== Wiki index (expand only what you need) ===',
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
