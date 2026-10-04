/* =============================================================================
 * guard.js — 공개 데모용 방어선
 * -----------------------------------------------------------------------------
 * /api/intent, /api/doctrine은 서버의 API 키로 LLM을 부른다. 공개 배포에서는
 * 누구나 이 엔드포인트를 직접 호출할 수 있으므로:
 *   1) 요청 본문 크기를 제한하고
 *   2) 클라이언트가 보낸 ctx를 그대로 프롬프트에 넣지 않고, 게임이 실제로 보내는
 *      모양으로 다시 만든다 (길이·개수 제한, role/trait는 서버가 아는 값만)
 *   3) IP별 요청 횟수를 제한한다
 *
 * 레이트 리밋은 인스턴스 메모리에 있다. 서버리스에서는 인스턴스마다 따로 세므로
 * 최선 노력일 뿐이다 — 진짜 상한은 OpenAI 프로젝트의 사용 한도로 걸어야 한다.
 * ========================================================================== */
'use strict';

// 게임(js/doctrine.js)의 ROLE_LABEL / TRAIT_LABEL과 같아야 한다.
const ROLES = [
  { key: 'frontline', label: '전열형' },
  { key: 'ranged', label: '원거리형' },
  { key: 'support', label: '지원형' },
  { key: 'elite', label: '정예형' }
];
const TRAITS = [
  { key: 'amplifier', label: '전력 증폭' },
  { key: 'volatile', label: '자폭' }
];
const ROLE_KEYS = ROLES.map(function (r) { return r.key; });
const TRAIT_KEYS = TRAITS.map(function (t) { return t.key; });

const MAX_BODY = 16 * 1024;     // 실제 요청은 2KB 안팎
const MAX_COMMAND = 200;        // 명령 입력창의 maxlength와 같다
const MAX_OUTPUT_TOKENS = 800;  // 응답은 스키마로 고정된 짧은 JSON

function str(v, max) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function list(v, max, map) {
  return Array.isArray(v) ? v.slice(0, max).map(map).filter(function (x) { return x != null; }) : [];
}

function known(keys) {
  return function (v) { return keys.indexOf(v) !== -1 ? v : null; };
}

function intentCtx(body) {
  const b = body || {};
  return {
    command: str(b.command, MAX_COMMAND),
    enemies: list(b.enemies, 12, function (e) { return str(e, 20) || null; }),
    roles: ROLES,
    traits: TRAITS
  };
}

function doctrineCtx(body) {
  const b = body || {};
  const battle = b.battle || {};
  return {
    command: str(b.command, MAX_COMMAND),
    stage: str(b.stage, 40),
    battle: {
      enemyRoles: list(battle.enemyRoles, 12, known(ROLE_KEYS)),
      killedRoles: list(battle.killedRoles, 12, known(ROLE_KEYS)),
      won: battle.won === true,
      firedDoctrineId: str(battle.firedDoctrineId, 60) || null,
      backfireTraits: list(battle.backfireTraits, 4, known(TRAIT_KEYS))
    },
    existing: list(b.existing, 8, function (d) {
      if (!d || typeof d !== 'object') return null;
      return {
        id: str(d.id, 60),
        name: str(d.name, 40),
        rule: str(d.rule, 120),
        role: known(ROLE_KEYS)(d.role),
        exceptTrait: known(TRAIT_KEYS)(d.exceptTrait),
        confidence: typeof d.confidence === 'number' ? d.confidence : null,
        uses: typeof d.uses === 'number' ? d.uses : 0
      };
    }),
    roles: ROLES,
    traits: TRAITS
  };
}

/* ---- IP별 레이트 리밋 (고정 창) ------------------------------------------ */
const WINDOWS = [
  { ms: 60 * 1000, max: 20 },            // 분당 20회 — 한 판에 2회 정도 부른다
  { ms: 24 * 60 * 60 * 1000, max: 300 }  // 하루 300회
];
const hits = new Map();

function allow(ip, now) {
  now = now || Date.now();
  const key = ip || 'unknown';
  let rec = hits.get(key);
  if (!rec) { rec = WINDOWS.map(function () { return { start: now, count: 0 }; }); hits.set(key, rec); }
  for (let i = 0; i < WINDOWS.length; i++) {
    if (now - rec[i].start >= WINDOWS[i].ms) { rec[i].start = now; rec[i].count = 0; }
    if (rec[i].count >= WINDOWS[i].max) return false;
  }
  rec.forEach(function (w) { w.count++; });
  if (hits.size > 10000) hits.clear();   // 메모리 상한
  return true;
}

function resetLimits() { hits.clear(); }

module.exports = {
  ROLES, TRAITS, MAX_BODY, MAX_COMMAND, MAX_OUTPUT_TOKENS,
  intentCtx, doctrineCtx, allow, resetLimits
};
