/* =============================================================================
 * brain.js — 지휘관 AI 두뇌 (Directive Interpreter)
 * -----------------------------------------------------------------------------
 * 이 게임의 심장. 플레이어가 쓴 "자연어 지시문"을 전투 에이전트가 실행 가능한
 * 정책(Policy) 객체로 변환한다. 스탯이 아니라 "프롬프트가 곧 빌드".
 *
 * 설계 원칙 (NAN 2026 "AI 에이전트 설계서" 관점)
 *   1) 해석 가능성: 지시문을 어떻게 이해했는지 사람이 읽을 수 있는 규칙 리스트로
 *      함께 반환한다. (화면에 "AI 해석 결과"로 표시 → 설명가능한 AI)
 *   2) 조합성: 여러 문장의 의도가 하나의 정책으로 누적된다.
 *   3) 교체 가능성: parseDirective()는 순수 함수. 로컬 규칙 파서를 그대로
 *      LLM 호출(async)로 교체해도 게임 루프는 바뀌지 않는다. (아래 LLMBrain 참고)
 * ========================================================================== */

(function (global) {
  'use strict';

  /** 정책 기본값 — 균형 잡힌 중립 에이전트 */
  function defaultPolicy() {
    return {
      retreatHpPct: 0.0,        // 이 체력 비율 아래면 후퇴 (0 = 후퇴 안 함)
      targetRole: null,         // ★ Doctrine의 실행부: frontline|ranged|support|elite (역할군 우선)
      targetExcept: null,       // ★ 예외 교리의 실행부: 이 특성(trait)을 가진 적은 우선 대상에서 제외
      targetAvoid: null,        // "방패 든 애는 무시해" — 이 역할군은 다른 적이 남아 있는 동안 치지 않는다
      targetPriority: 'nearest',// nearest | weakest | strongest | healer | archer | warrior
      focusFire: false,         // 아군이 한 대상에 화력 집중
      rescue: false,            // 포위된 아군을 구하러 이동
      protect: null,            // 특정 아군 타입 호위: 'healer' 등
      kite: false,              // 원거리 유닛이 거리를 유지하며 공격
      aggression: 0.5,          // 0(신중)~1(저돌) — 추격/교전 반경에 영향
      avoidHazards: false,      // 폭격/붕괴 등 위험 지대를 회피
      regroup: false,           // 아군 중심으로 집결(뭉치기)
      healPriority: 'lowestHp', // 힐러 전용: lowestHp | nearest
      _rules: [],               // 사람이 읽는 해석 결과 (UI 표시용)
      _matched: 0
    };
  }

  // 키워드 사전 (한국어 + 영어). 정규식 조각으로 사용.
  var K = {
    retreat: /(후퇴|도망|후退|도주|빠져|물러|retreat|flee|fall\s*back)/i,
    healerTarget: /(힐러|치유|회복|healer|medic).{0,6}(노려|공격|우선|저격|먼저|잡|kill|target|focus|first)/i,
    healerWord: /(힐러|치유|회복사|healer|medic)/i,
    archerWord: /(궁수|원거리|사수|archer|ranged)/i,
    warriorWord: /(전사|근접|탱커|warrior|melee|tank)/i,
    bossWord: /(보스|우두머리|대장|boss)/i,
    weakest: /(약한|낮은|피\s*적은|체력\s*낮|weak|low\s*hp|lowest)/i,
    strongest: /(강한|높은|튼튼|보스|strong|highest|tanky|boss)/i,
    focus: /(집중|몰아|한.?명|한.?놈|한.?체|focus\s*fire|focus|gang|nuke)/i,
    rescue: /(구해|구출|포위|둘러|도와|살려|rescue|surround|help|save)/i,
    protect: /(지켜|보호|호위|엄호|protect|guard|escort|defend)/i,
    kite: /(카이팅|거리\s*유지|거리를|치고\s*빠|무빙|피하면서|kite|kiting)/i,
    kiteLoose: /(카이팅|거리|치고\s*빠|kite|kiting)/i,
    aggressive: /(공격적|저돌|돌격|올인|밀어|공세|aggress|rush|all.?in|charge|push)/i,
    cautious: /(신중|방어적|수비|안전|조심|cautious|defensive|safe|careful)/i,
    hazard: /(폭격|폭탄|공습|포격|낙하|위험\s*지대|위험\s*지역|위험지대|화염|균열|붕괴|피해라|피하고|피하면서|흩어|산개|회피|danger|airstrike|bomb|hazard|spread\s*out|scatter|avoid)/i,
    regroup: /(뭉쳐|뭉치|집결|모여|모이|밀집|규합|regroup|rally|group\s*up|stick\s*together)/i
  };

  function extractPct(text) {
    var m = text.match(/(\d{1,3})\s*(%|퍼|퍼센트|percent)/i);
    if (m) return Math.max(0, Math.min(100, parseInt(m[1], 10))) / 100;
    var f = text.match(/0?\.(\d+)/);
    if (f) return Math.max(0, Math.min(1, parseFloat('0.' + f[1])));
    return null;
  }

  /**
   * 자연어 명령 한 줄 -> 조각(sparse). 감지된 필드만 담는다.
   * @returns {{set:object, rules:string[], matched:number}}
   */
  function parseFragment(text) {
    var set = {}, rules = [], m = 0;
    if (!text || !text.trim()) return { set: set, rules: rules, matched: 0 };
    var t = text.trim();

    if (K.retreat.test(t)) {
      var pct = extractPct(t); set.retreatHpPct = pct != null ? pct : 0.3;
      rules.push('체력 ' + Math.round(set.retreatHpPct * 100) + '% 이하 → 후퇴'); m++;
    }
    if (K.healerTarget.test(t) || (K.healerWord.test(t) && /(노려|저격|잡|먼저|우선|kill|target|focus|first)/i.test(t))) {
      set.targetPriority = 'healer'; rules.push('적 힐러 최우선 저격'); m++;
    } else if (K.strongest.test(t) || (K.bossWord.test(t))) {
      set.targetPriority = 'strongest'; rules.push('가장 강한 적(보스) 우선'); m++;
    } else if (K.weakest.test(t)) {
      set.targetPriority = 'weakest'; rules.push('체력 낮은 적부터 처치'); m++;
    } else if (K.archerWord.test(t) && /(노려|저격|잡|우선|먼저|끊|kill|target|focus)/i.test(t)) {
      set.targetPriority = 'archer'; rules.push('적 원거리 유닛 우선 처치'); m++;
    }
    if (K.focus.test(t)) { set.focusFire = true; rules.push('부대 화력 집중(같은 대상)'); m++; }
    if (K.rescue.test(t) && !K.hazard.test(t)) { set.rescue = true; rules.push('포위된 아군 구출'); m++; }
    if (K.protect.test(t)) {
      set.protect = K.archerWord.test(t) ? 'archer' : 'healer';
      rules.push(set.protect === 'archer' ? '아군 원거리 호위' : '아군 힐러 호위'); m++;
    }
    if (K.kite.test(t) || (K.kiteLoose.test(t) && K.archerWord.test(t))) {
      set.kite = true; rules.push('원거리 유닛 거리 유지(카이팅)'); m++;
    }
    if (K.hazard.test(t)) { set.avoidHazards = true; rules.push('⚠ 위험 지대(폭격·붕괴) 회피'); m++; }
    if (K.regroup.test(t)) { set.regroup = true; rules.push('아군 집결(뭉치기)'); m++; }
    if (K.aggressive.test(t)) { set.aggression = 0.9; rules.push('공격적 성향(적극 교전)'); m++; }
    else if (K.cautious.test(t)) { set.aggression = 0.2; if (set.retreatHpPct == null) set.retreatHpPct = 0.35; rules.push('신중한 성향'); m++; }

    return { set: set, rules: rules, matched: m };
  }

  // 조각 하나를 정책에 적용 (불리언 OR 누적, 스칼라/열거는 덮어쓰기)
  // ⚠ targetRole/targetExcept를 빠뜨리면 안 된다: 전투 중 규칙을 추가하면 composePolicy가
  //   정책을 재구성하는데, 그때 교리·해석이 심어둔 targetRole이 null로 덮여 조용히 증발한다.
  function applyFragment(p, set) {
    ['focusFire', 'kite', 'rescue', 'avoidHazards', 'regroup'].forEach(function (k) { if (set[k]) p[k] = true; });
    ['retreatHpPct', 'targetPriority', 'aggression', 'protect', 'targetRole', 'targetExcept', 'targetAvoid']
      .forEach(function (k) { if (set[k] !== undefined) p[k] = set[k]; });
  }

  /** 규칙 스택(조각 배열) -> 누적 정책. 나중 규칙이 우선. */
  function composePolicy(fragments) {
    var p = defaultPolicy(), seen = {};
    for (var i = 0; i < fragments.length; i++) {
      applyFragment(p, fragments[i].set);
      var rr = fragments[i].rules;
      for (var j = 0; j < rr.length; j++) if (!seen[rr[j]]) { seen[rr[j]] = 1; p._rules.push(rr[j]); }
      p._matched += fragments[i].matched;
    }
    return p;
  }

  /** 단일 지시문 -> 정책 (하위호환) */
  function parseDirective(text) {
    var f = parseFragment(text);
    var p = composePolicy([f]);
    if (f.matched === 0) p._rules = ['인식된 전술 없음 → 기본 교전. 예: "체력 30% 이하 후퇴, 적 힐러 집중"'];
    return p;
  }

  /* ---------------------------------------------------------------------------
   * LLMBrain (선택/확장 슬롯)
   * 로컬 규칙 파서와 동일한 계약(정책 반환)을 갖는 비동기 어댑터.
   * 실제 대회 본선에서는 이 함수 몸통을 Claude 등 LLM 호출로 교체하면 된다.
   * 게임 루프는 정책 객체만 소비하므로 아무 것도 바꿀 필요가 없다.
   * ------------------------------------------------------------------------- */
  async function parseDirectiveLLM(text, opts) {
    // 예시 계약 (본선 구현 시):
    //   const res = await fetch('/api/interpret', {method:'POST', body: text});
    //   const policy = await res.json(); return normalize(policy);
    // 지금은 데모 가동을 위해 로컬 파서로 폴백.
    return parseDirective(text);
  }

  global.CommanderBrain = {
    parseDirective: parseDirective,
    parseFragment: parseFragment,
    composePolicy: composePolicy,
    parseDirectiveLLM: parseDirectiveLLM,
    defaultPolicy: defaultPolicy
  };
})(typeof window !== 'undefined' ? window : globalThis);
