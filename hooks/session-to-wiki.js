#!/usr/bin/env node

/**
 * session-to-wiki.js — SessionEnd hook (자동 위키화 트리거)
 *
 * 세션 종료 시, 원본 저장 직후 백그라운드로 wiki-distill-worker.js 를 띄운다.
 * 워커가 원본을 가볍게 읽어 Haiku로 위키 노트를 만들므로, 종료/재접속은
 * 전혀 느려지지 않는다(비차단·detached).
 *
 * 재귀 방지: CLAUDE_WIKI_CHILD 가 있으면(=워커가 띄운 claude 세션) 아무것도 안 함.
 */

const path = require('path');
const { spawn } = require('child_process');

let buf = '';
let done = false;

function finish() {
  if (done) return;
  done = true;
  try {
    if (process.env.CLAUDE_WIKI_CHILD) return process.exit(0); // 재귀 방지

    let d = {};
    try { d = JSON.parse(buf || '{}'); } catch (e) {}

    const cwd = d.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const transcript = d.transcript_path;
    const sid = String(d.session_id || 'unknown');
    if (!transcript) return process.exit(0);

    const worker = path.join(__dirname, 'wiki-distill-worker.js');
    const child = spawn(process.execPath, [worker, transcript, cwd, sid], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CLAUDE_WIKI_CHILD: '1' }
    });
    child.unref();
  } catch (e) {}
  process.exit(0);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { buf += c; });
process.stdin.on('end', finish);
setTimeout(finish, 2000);
