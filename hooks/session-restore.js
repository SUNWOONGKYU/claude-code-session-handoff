#!/usr/bin/env node

/**
 * session-restore.js — SessionStart hook (직전 맥락 주입)
 *
 * 새 세션 시작 시 stdout으로 출력 → 새 세션 맨 앞 컨텍스트로 자동 주입.
 * 주입 내용(가볍게 둘 다):
 *   ① 이어가기 요약  : <cwd>/sessions/LATEST.md  (전체)
 *   ② 위키 목차      : <cwd>/sessions/wiki/*.md  (제목 목록만 — 필요한 것만 펼쳐 읽도록)
 * 둘 다 없고 raw만 있으면 → 최신 raw 포인터.
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

    const out = [];

    // ① 이어가기 요약 — summary 폴더의 '가장 최신' 1개만 읽음 (누적되지만 최신만 참조)
    const latestSummary = newestIn(summaryDir, '.md');
    if (latestSummary) {
      out.push('=== 직전 세션 이어가기 요약 (자동 주입) ===');
      out.push(fs.readFileSync(latestSummary, 'utf8').trim());
    }

    // ② 직전 위키 노트 (본문 전체) — INDEX.md 제외, 가장 최신
    if (fs.existsSync(wikiDir)) {
      const notes = fs.readdirSync(wikiDir)
        .filter(f => f.endsWith('.md') && f !== 'INDEX.md')
        .map(f => ({ f, m: fs.statSync(path.join(wikiDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (notes.length) {
        out.push('');
        out.push('=== 직전 세션 위키 노트 (자동 주입) ===');
        out.push(fs.readFileSync(path.join(wikiDir, notes[0].f), 'utf8').trim());
      }
      // ③ 위키 인덱스(INDEX.md) 전체 — 쌓인 지식 목록(한 줄 설명 포함)
      const indexFile = path.join(wikiDir, 'INDEX.md');
      if (fs.existsSync(indexFile)) {
        out.push('');
        out.push('=== 위키 인덱스 (필요한 항목만 펼쳐 읽으세요) ===');
        out.push(fs.readFileSync(indexFile, 'utf8').trim());
      }
    }

    if (out.length) {
      out.push('---');
      out.push('(이어서 작업하려면 위 요약을 참고하고, 더 깊은 맥락은 위키 항목이나 sessions/raw 원본을 필요한 만큼만 읽으세요.)');
      console.log(out.join('\n'));
      return process.exit(0);
    }

    // 폴백: 요약·위키 없고 raw만 있으면 최신 원본 포인터
    const rawDir = path.join(sessionsDir, 'raw');
    if (fs.existsSync(rawDir)) {
      const files = fs.readdirSync(rawDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, m: fs.statSync(path.join(rawDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) {
        console.log('=== 직전 세션 원본 있음 (아직 요약/위키 없음) ===');
        console.log('이어서 작업하려면 필요한 부분만 읽으세요: ' + path.join(rawDir, files[0].f));
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
