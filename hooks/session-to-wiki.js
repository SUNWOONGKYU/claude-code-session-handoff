#!/usr/bin/env node

/**
 * session-to-wiki.js — SessionEnd hook (자동 위키화 트리거)
 *
 * 세션 종료 시, 원본 저장 직후 백그라운드로 wiki-distill-worker.js 를 띄운다.
 * 워커가 원본을 가볍게 읽어 Sonnet으로 요약·위키 노트를 만들므로, 종료/재접속은
 * 전혀 느려지지 않는다(비차단·detached).
 *
 * 재귀 방지: CLAUDE_WIKI_CHILD 가 있으면(=워커가 띄운 claude 세션) 아무것도 안 함.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { gitRootOf } = require('./lib-project-dir');

// '작업 중이던 그 세션'만 저장하기 위한 판별 (요건: 다른 세션 섞임 차단).
// 마이두(mydoo) 환경에서는 진짜 대화도 entrypoint='sdk-cli', promptSource 없음 → 그 기준 사용 불가.
// 대신 user 메시지 수 ≥ 2를 기준으로 판별:
//   - 진짜 대화 세션: 여러 turn (user ≥ 2)
//   - wiki-distill-worker / 서브에이전트 : user 1개짜리 (거대 프롬프트 1회 → 응답)
function isInteractiveSession(transcriptPath) {
  try {
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    let userCount = 0;
    for (const ln of lines) {
      const s = ln.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      if (o.type === 'user') userCount++;
      if (userCount >= 2) return true;  // 사람과 주고받는 세션 → 인터랙티브 확정
    }
    return false;  // user 1개 이하 = wiki-worker 또는 단발 서브에이전트 → 스킵
  } catch { return true; }  // 못 읽으면 안전망으로 저장 허용
}

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

    // 요건 2: '작업 중이던 그 세션'만 저장 — 워크플로/서브에이전트/SDK 세션은 요약 생성 건너뜀.
    // (이 가드가 없으면 같은 디렉토리의 부산물 세션 요약이 summary/에 쏟아져 복원 시 엉뚱한 세션이 잡힘.)
    if (fs.existsSync(transcript) && !isInteractiveSession(transcript)) {
      return process.exit(0);
    }

    // git 루트 한 곳에 요약·위키를 저장한다 — 하위 폴더(예: SAAH/guide)에서 켜도 통일.
    // 복원 훅(session-restore.js)과 동일 기준이어야 새 세션이 같은 곳에서 읽는다. (PO 지시 2026-06-26)
    const projectDir = gitRootOf(cwd) || cwd;

    // cloop 재접속이 증류 완료를 기다리도록 '진행중' 마커 생성 (워커가 끝나면 제거).
    // 이게 없으면 cloop이 5초 만에 재접속해 새 세션이 아직 안 만들어진 요약을 못 읽는다.
    try {
      const sdir = path.join(projectDir, 'sessions');
      if (!fs.existsSync(sdir)) fs.mkdirSync(sdir, { recursive: true });
      fs.writeFileSync(path.join(sdir, '.distilling'), String(Date.now()));
    } catch (e) {}

    const worker = path.join(__dirname, 'wiki-distill-worker.js');
    const child = spawn(process.execPath, [worker, transcript, projectDir, sid], {
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
