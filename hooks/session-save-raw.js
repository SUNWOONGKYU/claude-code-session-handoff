#!/usr/bin/env node

/**
 * session-save-raw.js — SessionEnd hook (안전망 raw 저장)
 *
 * 세션이 끝날 때(Ctrl+D / /exit 등) 발동.
 * stdin JSON의 transcript_path(이번 세션 대화 .jsonl)를 읽어
 * <cwd>\sessions\raw\ 에 그대로 복사한다. 폴더 없으면 만든다.
 *
 * - 증류(요약)는 하지 않는다. raw 보존만 담당 (증류는 session-to-wiki.js가 띄우는 워커가 함).
 * - 멱등: 같은 session_id 파일이 이미 있으면 건너뛴다 (중복 방지).
 * - source=clear 등 어떤 reason이든 raw는 보존한다.
 * - 절대 차단하지 않음(exit 0). SessionEnd는 종료를 막을 수 없음.
 */

const fs = require('fs');
const path = require('path');

let buf = '';
let done = false;

function ts() {
  const n = new Date();
  const p = x => String(x).padStart(2, '0');
  return `${n.getFullYear()}_${p(n.getMonth() + 1)}_${p(n.getDate())}__${p(n.getHours())}.${p(n.getMinutes())}`;
}

function ensureDir(d) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function finish() {
  if (done) return;
  done = true;
  try {
    if (process.env.CLAUDE_WIKI_CHILD) return process.exit(0); // 위키 워커가 띄운 세션 — 건너뜀

    let d = {};
    try { d = JSON.parse(buf || '{}'); } catch {}

    const cwd = d.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const transcript = d.transcript_path;
    const sessionId = String(d.session_id || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);

    if (!transcript || !fs.existsSync(transcript)) {
      console.log(`[session-save-raw] transcript 없음 — 저장 건너뜀`);
      return process.exit(0);
    }

    const rawDir = path.join(cwd, 'sessions', 'raw');
    ensureDir(rawDir);

    // 멱등: 같은 session_id 파일이 이미 있으면 스킵
    const already = fs.readdirSync(rawDir).some(f => f.includes(sessionId));
    if (already) {
      console.log(`[session-save-raw] 이미 저장된 세션(${sessionId}) — 건너뜀`);
      return process.exit(0);
    }

    const out = path.join(rawDir, `${ts()}_${sessionId}.jsonl`);
    fs.copyFileSync(transcript, out);
    console.log(`[session-save-raw] raw 저장 완료 → ${out}`);
  } catch (e) {
    console.error(`[session-save-raw] 실패: ${e.message}`);
  }
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', finish);
setTimeout(finish, 4000);
