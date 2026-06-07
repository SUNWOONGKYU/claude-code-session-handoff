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
 * 인증: 잘못된 ANTHROPIC_API_KEY 제거 후 OAuth 사용.
 * 재귀 방지: claude 자식에 CLAUDE_WIKI_CHILD=1 → 그 세션의 훅들은 건너뜀.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const transcript = process.argv[2];
const cwd = process.argv[3];
const sid = (process.argv[4] || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40);

const sessionsDir = path.join(cwd, 'sessions');
const wikiDir = path.join(sessionsDir, 'wiki');       // 위키 노트(지식) 누적
const summaryDir = path.join(sessionsDir, 'summary'); // 이어가기 요약 누적 (덮어쓰지 않음)
const logFile = path.join(sessionsDir, '.wiki-distill.log');

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
  return text.slice(-24000); // 가볍게: 최근 24,000자만 사용
}

function main() {
  if (!transcript || !fs.existsSync(transcript)) { log('transcript 없음: ' + transcript); return; }
  if (!fs.existsSync(wikiDir)) fs.mkdirSync(wikiDir, { recursive: true });
  if (!fs.existsSync(summaryDir)) fs.mkdirSync(summaryDir, { recursive: true });

  const convo = extractConvo();
  if (!convo.trim()) { log('대화 텍스트 없음 — 건너뜀'); return; }

  const project = path.basename(cwd);
  // 한 번의 호출로 두 섹션 출력 (마커로 구분). 프롬프트는 한 줄(cmd 안전).
  const PROMPT = "다음 입력은 Claude Code 세션 전사록이다. 한국어로 세 부분만 출력하라. (1) 한 줄에 @@@TITLE@@@ 만 단독으로 쓰고 그 아래 이 세션을 한 문장(40자 이내)으로 압축한 제목 한 줄. (2) 한 줄에 @@@HANDOFF@@@ 만 단독으로 쓰고 그 아래 '## 한 일 / ## 현재 상태 / ## 다음 할 일' 형식의 6~10줄 이어가기 요약. (3) 한 줄에 @@@WIKI@@@ 만 단독으로 쓰고 그 아래 이번 세션의 핵심 지식·결정·산출물을 주제별로 정리하고 관련 개념은 [[제목]] 형식 위키링크로 표시한 지식 노트. 세 마커는 각각 한 줄에 단독으로. 머리말·설명 없이 세 부분만 출력.";
  const cmd = `claude -p "${PROMPT}" --model claude-sonnet-4-6 --dangerously-skip-permissions`;

  const env = { ...process.env, CLAUDE_WIKI_CHILD: '1' };
  delete env.ANTHROPIC_API_KEY; // 잘못된 키 제거 → OAuth 사용

  log('claude(Sonnet) 호출 시작 (입력 ' + convo.length + '자)');
  let out = '', err = '';
  const ch = spawn(cmd, { shell: true, env, windowsHide: true });
  ch.stdout.on('data', d => out += d.toString());
  ch.stderr.on('data', d => err += d.toString());
  const killer = setTimeout(() => { try { ch.kill(); } catch (e) {} log('타임아웃 150s'); }, 150000);
  ch.on('error', e => { clearTimeout(killer); log('spawn 오류: ' + e.message); });
  ch.on('close', code => {
    clearTimeout(killer);
    const full = (out || '').trim();
    if (!full) { log('빈 출력 (code ' + code + '), stderr: ' + err.slice(0, 300)); return; }

    // 세 섹션 분리 — 마커는 '한 줄에 단독'인 경우만 인정(본문 속 언급과 충돌 방지)
    const lines = full.split('\n');
    const ti = lines.findIndex(l => l.trim() === '@@@TITLE@@@');
    const hi = lines.findIndex(l => l.trim() === '@@@HANDOFF@@@');
    const wi = lines.findIndex(l => l.trim() === '@@@WIKI@@@');
    let title = '', summary, wiki;
    if (hi >= 0 && wi >= 0) {
      title = lines.slice(ti >= 0 ? ti + 1 : 0, hi).join(' ').trim();
      summary = lines.slice(hi + 1, wi).join('\n').trim();
      wiki = lines.slice(wi + 1).join('\n').trim();
    } else {
      log('마커 부족 — 전체를 양쪽에 저장(폴백)');
      summary = full.replace(/@@@\w+@@@/g, '').trim();
      wiki = summary;
    }
    if (!title) title = `${project} 세션`;

    const dateIso = new Date().toISOString();
    const stamp = ts();
    try {
      // ① 이어가기 요약 → summary 폴더에 누적(매번 새 파일, 덮어쓰지 않음)
      const summaryNote = `---\ndate: ${dateIso}\nproject: ${project}\ntype: handoff-summary\nsource: auto (SessionEnd / Sonnet)\n---\n\n# 이어가기 요약 — ${project} (${stamp})\n\n${summary}\n`;
      fs.writeFileSync(path.join(summaryDir, `${stamp}_${sid}_요약.md`), summaryNote, 'utf8');
      log('이어가기 요약 저장(summary/ 누적)');

      // ② 위키 노트 → wiki 폴더에 누적
      const wikiBase = `${stamp}_${sid}_위키`;
      const wikiNote = `---\ndate: ${dateIso}\nproject: ${project}\ntype: session-wiki\nsource: auto (SessionEnd / Sonnet)\ntags: [wiki, ${project}]\n---\n\n# ${title}\n\n${wiki}\n`;
      fs.writeFileSync(path.join(wikiDir, wikiBase + '.md'), wikiNote, 'utf8');
      log('위키 노트 작성: ' + wikiBase);

      // ③ 위키 인덱스(INDEX.md) 갱신 — 한 줄 설명 추가(최신이 맨 위)
      const indexFile = path.join(wikiDir, 'INDEX.md');
      let entries = [];
      try { if (fs.existsSync(indexFile)) entries = fs.readFileSync(indexFile, 'utf8').split('\n').filter(l => l.startsWith('- ')); } catch (e) {}
      entries.unshift(`- [[${wikiBase}]] — ${title.replace(/\s+/g, ' ').trim()}`);
      fs.writeFileSync(indexFile, '# 위키 인덱스\n\n' + entries.join('\n') + '\n', 'utf8');
      log('INDEX.md 갱신');
    } catch (e) { log('쓰기 실패: ' + e.message); }
  });
  ch.stdin.write(convo);
  ch.stdin.end();
}
main();
