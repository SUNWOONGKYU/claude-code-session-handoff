#!/usr/bin/env node

/**
 * session-restore.js — SessionStart hook (직전 맥락 주입)
 *
 * 새 세션 시작 시 발동. stdout으로 출력한 내용은 새 세션의
 * 맨 앞 컨텍스트로 자동 주입된다(SessionStart 고유 특성).
 *
 * 동작:
 *  1) <cwd>\sessions\LATEST.md 가 있으면 → 그 내용을 주입 (가벼운 증류 노트)
 *  2) 없고 raw만 있으면 → 최신 raw 경로 포인터 주입 ("아직 증류 안 됨")
 *  3) 둘 다 없으면 → 아무것도 출력 안 함 (새 프로젝트)
 *  4) source=clear(사용자가 일부러 초기화) → 주입 생략
 *
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
    let d = {};
    try { d = JSON.parse(buf || '{}'); } catch {}

    const source = d.source || 'startup';
    if (source === 'clear') return process.exit(0); // 의도적 초기화 — 주입 생략

    const cwd = d.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const sessionsDir = path.join(cwd, 'sessions');
    const latest = path.join(sessionsDir, 'LATEST.md');

    if (fs.existsSync(latest)) {
      const note = fs.readFileSync(latest, 'utf8');
      console.log('=== 직전 세션 이어가기 (자동 주입) ===');
      console.log('아래는 직전 세션의 가벼운 요약입니다. 사용자가 이어서 작업하자고 하면 참고하세요.');
      console.log('더 깊은 맥락이 필요하면 ' + path.join(sessionsDir, 'raw') + ' 의 원본을 필요한 부분만 읽으세요.');
      console.log('---');
      console.log(note);
      console.log('=== (이어가기 끝) ===');
      return process.exit(0);
    }

    // LATEST.md 없음 → 최신 raw 포인터
    const rawDir = path.join(sessionsDir, 'raw');
    if (fs.existsSync(rawDir)) {
      const files = fs.readdirSync(rawDir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => ({ f, m: fs.statSync(path.join(rawDir, f)).mtimeMs }))
        .sort((a, b) => b.m - a.m);
      if (files.length) {
        console.log('=== 직전 세션 원본 있음 (아직 증류 안 됨) ===');
        console.log('직전 세션 요약 노트가 없습니다. 이어서 작업하려면 아래 원본에서 필요한 부분만 읽으세요:');
        console.log(path.join(rawDir, files[0].f));
        console.log('=== 끝 ===');
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
