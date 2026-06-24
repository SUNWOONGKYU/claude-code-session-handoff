#!/usr/bin/env node

/**
 * lib-project-dir.js — "실제 작업한 프로젝트 폴더" 추론 헬퍼
 *
 * 세션 핸드오프(요약·위키·raw)는 원래 cwd(=claude를 켠 폴더)/sessions 에 저장된다.
 * 그런데 cwd는 '켠 위치'로 고정되고 세션 중 cd로 바뀌지 않으므로, Desktop에서 켜고
 * 다른 프로젝트(예: C:\Dev\DID_system)를 작업하면 핸드오프가 Desktop에 쌓이는 문제가 있었다.
 *
 * 이 헬퍼는 세션 전사(transcript)를 읽어 '실제로 편집·작업한 파일들'이 속한
 * git 프로젝트 루트를 찾아, 그곳을 저장 대상으로 돌려준다. (없으면 cwd 폴백.)
 *
 * 절대 throw 하지 않는다 — 어떤 오류든 cwd를 반환해 훅이 깨지지 않게 한다.
 */

const fs = require('fs');
const path = require('path');

// 경로에서 가장 가까운 상위 .git 디렉토리(=프로젝트 루트)를 찾는다. 없으면 null.
function gitRootOf(p) {
  try {
    let dir = (fs.existsSync(p) && fs.statSync(p).isDirectory()) ? p : path.dirname(p);
    for (let i = 0; i < 40; i++) {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
      const parent = path.dirname(dir);
      if (parent === dir) break; // 파일시스템 루트 도달
      dir = parent;
    }
  } catch (e) {}
  return null;
}

// 전사에서 작업 파일 경로를 추출 → 프로젝트 루트별 가중치 합산 → 최다 루트 반환.
// 못 찾으면 cwd 폴백.
function resolveProjectDir(cwd, transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return cwd;

    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n');
    const weights = new Map(); // gitRoot -> 누적 가중치

    // ~/.claude 설정·훅·스킬 폴더는 '프로젝트'로 치지 않는다(핸드오프 대상 아님).
    const CONFIG_DIR = path.join(process.env.USERPROFILE || process.env.HOME || '', '.claude').toLowerCase();

    const add = (p, w) => {
      if (!p || typeof p !== 'string') return;
      if (!path.isAbsolute(p)) return;              // 상대경로는 신뢰 불가(스킵)
      if (p.toLowerCase().startsWith(CONFIG_DIR)) return; // 설정 폴더 제외
      const root = gitRootOf(p);
      if (!root) return;
      weights.set(root, (weights.get(root) || 0) + w);
    };

    // 편집류는 강하게, 읽기는 약하게, Bash 경로는 보조 신호.
    const TOOL_WEIGHT = { Write: 3, Edit: 3, MultiEdit: 3, NotebookEdit: 3, Read: 1 };

    for (const ln of lines) {
      const s = ln.trim(); if (!s) continue;
      let o; try { o = JSON.parse(s); } catch { continue; }
      const msg = o.message || o;
      const content = msg && msg.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || b.type !== 'tool_use') continue;
        const inp = b.input || {};
        const w = TOOL_WEIGHT[b.name];
        if (w && inp.file_path) add(inp.file_path, w);
        // Bash 명령 안의 절대경로(Windows 드라이브 경로)를 약하게 반영
        if (b.name === 'Bash' && typeof inp.command === 'string') {
          const m = inp.command.match(/[A-Za-z]:[\\/][^\s"'|;&)<>]+/g);
          if (m) for (const hit of m.slice(0, 10)) add(hit, 0.3);
        }
      }
    }

    if (!weights.size) return cwd;

    let best = null, bestW = 0;
    for (const [root, w] of weights) if (w > bestW) { best = root; bestW = w; }
    if (best && fs.existsSync(best)) return best;
    return cwd;
  } catch (e) {
    return cwd;
  }
}

module.exports = { resolveProjectDir, gitRootOf };
