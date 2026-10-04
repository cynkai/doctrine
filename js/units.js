/* =============================================================================
 * units.js — 유닛 아키타입 & 전투 헬퍼 (순수 로직)
 * -----------------------------------------------------------------------------
 * 렌더링/루프와 분리된 순수 함수 계층. 정책(policy)이 "무엇을" 하라고 지시하면,
 * 아키타입이 "어떻게"의 물리적 능력치를 정의한다.
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------------------
   * ★ 역할 분류(Role Taxonomy) — 이 게임의 린치핀.
   * Doctrine은 "힐러를 노려라"(유닛 이름)가 아니라 "지원형을 노려라"(역할군)로
   * 일반화된다. 그래서 힐러가 없는 전장에서도 같은 교리가 버퍼를 타격한다.
   *   frontline · ranged · support · elite
   * ------------------------------------------------------------------------- */
  var ROLES = {
    frontline: { key: 'frontline', label: '전열형' },
    ranged: { key: 'ranged', label: '원거리형' },
    support: { key: 'support', label: '지원형' },
    elite: { key: 'elite', label: '정예형' }
  };

  /* ---------------------------------------------------------------------------
   * ★ 특성(Trait) — 교리가 "패턴"이 아니라 "원리"가 되게 하는 장치.
   *
   *   ❌ 패턴: "힐러를 먼저 친다"            (유닛 이름 암기)
   *   ⭕ 원리: "적 전력을 증폭하는 적이 있으면, 그를 먼저 친다"  (전장에 대한 술어)
   *
   * 교리는 role뿐 아니라 trait에 대한 조건으로 표현된다. 그래서
   *   - amplifier가 없는 전장에서는 교리가 아예 발동하지 않고(조건 불성립),
   *   - volatile(자폭)처럼 교리를 적용하면 오히려 손해인 예외를 인식할 수 있다.
   * ------------------------------------------------------------------------- */
  var TRAITS = {
    amplifier: { key: 'amplifier', label: '전력 증폭', desc: '살아있는 동안 적 전체의 지속력·화력을 끌어올린다' },
    volatile: { key: 'volatile', label: '자폭', desc: '사망 시 주변에 광역 피해를 입힌다' }
  };

  /** 이 유닛이 해당 특성을 가졌는가 */
  function hasTrait(u, t) {
    var list = u.arch.traits || [];
    return list.indexOf(t) !== -1;
  }
  /** 전장에 해당 특성을 가진 적이 존재하는가 — 교리 조건(condition)의 판정부 */
  function fieldHasTrait(enemies, t) {
    for (var i = 0; i < enemies.length; i++)
      if (enemies[i].alive && hasTrait(enemies[i], t)) return true;
    return false;
  }

  var ARCHETYPES = {
    warrior: {
      key: 'warrior', label: '전사', glyph: '⚔', role: 'frontline',
      maxHp: 208, dmg: 7, attackRange: 30, attackCd: 0.55,
      speed: 62, radius: 13, prefDist: 0, ranged: false, healer: false
    },
    archer: {
      key: 'archer', label: '궁수', glyph: '🏹', role: 'ranged',
      maxHp: 100, dmg: 6, attackRange: 165, attackCd: 0.75,
      speed: 70, radius: 11, prefDist: 130, ranged: true, healer: false
    },
    healer: {
      key: 'healer', label: '힐러', glyph: '✚', role: 'support',
      maxHp: 115, dmg: 3, attackRange: 140, attackCd: 1.0,
      heal: 10, healRange: 150, speed: 66, radius: 11,
      prefDist: 120, ranged: true, healer: true,
      traits: ['amplifier']
    },
    // ★ 버퍼 — 힐러와 같은 support 역할군. 주변 아군의 공격력을 올린다.
    //   살려두면 적 전체가 강해지므로, "지원형 우선" 교리의 적용이 실제로 옳은 판단이 된다.
    buffer: {
      key: 'buffer', label: '버퍼', glyph: '⚑', role: 'support',
      maxHp: 105, dmg: 4, attackRange: 130, attackCd: 1.0,
      speed: 66, radius: 11, prefDist: 120, ranged: true,
      healer: false, buffer: true, auraRange: 175, auraDmg: 0.45,  // 아군 공격력 +45%
      traits: ['amplifier']
    },
    // ★ 폭탄 힐러 — support · amplifier인데 **volatile**이다.
    //   "지원형 우선 제거" 교리를 그대로 적용하면 폭발에 아군이 갈린다.
    //   즉 교리가 옳았던 세 판 뒤에, 교리가 틀리는 판. 여기서 AI는 예외를 배운다.
    bomber: {
      key: 'bomber', label: '폭탄 힐러', glyph: '☣', role: 'support',
      maxHp: 120, dmg: 3, attackRange: 140, attackCd: 1.0,
      heal: 9, healRange: 150, speed: 62, radius: 12,
      prefDist: 120, ranged: true, healer: true,
      // 사망 시 광역 피해. 반경은 궁수 사거리(165)보다 넓다 — 멀리서 저격해도 휩쓸린다.
      // 그래서 "먼저 제거한다"는 교리를 그대로 적용하면 반드시 대가를 치른다.
      // 반대로 무시하고 나머지를 정리하면, 힐러는 canAttack에 포함되지 않으므로
      // 터뜨리지 않고도 승리한다 = 예외 교리가 실제로 옳은 판단이 된다.
      // 검증(각 20회): 교리 맹신 = 승률 0% / 예외 학습 = 승률 100%.
      traits: ['amplifier', 'volatile'],
      blastRange: 250, blastDmg: 210
    },
    boss: {
      key: 'boss', label: '보스', glyph: '☠', role: 'elite',
      maxHp: 300, dmg: 10, attackRange: 48, attackCd: 0.72,
      speed: 46, radius: 22, prefDist: 0, ranged: false, healer: false, boss: true
    }
  };

  /** 버퍼 오라: 같은 팀의 살아있는 버퍼가 사거리 안에 있으면 공격력 배율 반환 */
  function buffMul(u, allies) {
    var m = 1;
    for (var i = 0; i < allies.length; i++) {
      var a = allies[i];
      if (!a.alive || !a.arch.buffer || a === u) continue;
      if (dist(u, a) <= a.arch.auraRange) m += a.arch.auraDmg;
    }
    return m;
  }

  function dist(a, b) {
    var dx = a.x - b.x, dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function alive(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) if (list[i].alive) out.push(list[i]);
    return out;
  }

  function canAttack(list) { // 데미지를 낼 수 있는(=승리에 기여) 살아있는 유닛
    var out = [];
    for (var i = 0; i < list.length; i++)
      if (list[i].alive && !list[i].arch.healer) out.push(list[i]);
    return out;
  }

  /**
   * 정책에 따른 타겟 선택. (대형 안정: 우선순위/집중은 "닿는 범위" 안에서만 적용,
   * 멀리 있는 힐러 등을 쫓아 맵을 가로지르지 않는다 → 기본은 항상 가장 가까운 적)
   * @param {object} self   판단 주체 유닛
   * @param {array}  enemies 살아있는 적 목록
   * @param {object} policy
   * @param {object|null} teamFocus  화력집중 시 팀 공용 타겟(교전 중 최저 HP)
   * @param {number} reach  이 거리 이내여야 우선순위 타겟을 채택
   */
  function chooseTarget(self, enemies, policy, teamFocus, reach) {
    if (!enemies.length) return null;
    enemies = withoutRole(enemies, policy.targetAvoid);
    reach = reach || 1e9;
    var nearest = minBy(enemies, function (e) { return dist(self, e); });

    // 화력 집중: 팀 공용 타겟이 닿는 범위면 채택
    if (policy.focusFire && teamFocus && teamFocus.alive && dist(self, teamFocus) <= reach)
      return teamFocus;

    // ★ 역할군 우선(Doctrine의 실행부). targetRole이 있으면 유닛 이름이 아니라
    //   역할로 매칭 → 힐러가 없어도 같은 교리가 버퍼(둘 다 support)를 타격한다.
    //   targetExcept이 있으면 그 특성을 가진 적은 우선 대상에서 뺀다(예외 교리).
    var pool = rolePool(enemies, policy.targetRole, policy.targetExcept);
    if (pool) {
      var rt = minBy(pool, function (e) { return dist(self, e); });
      if (dist(self, rt) <= reach) return rt;
    }

    var pri = policy.targetPriority, typed = null;
    if (pri === 'healer') typed = enemies.filter(function (e) { return e.arch.healer; });
    else if (pri === 'archer') typed = enemies.filter(function (e) { return e.arch.key === 'archer'; });
    else if (pri === 'warrior') typed = enemies.filter(function (e) { return e.arch.key === 'warrior'; });
    if (typed && typed.length) {
      var t = minBy(typed, function (e) { return dist(self, e); });
      if (dist(self, t) <= reach) return t;       // 가까우면 우선 타입 저격
    }
    if (pri === 'weakest') { var w = minBy(enemies, function (e) { return e.hp; }); if (dist(self, w) <= reach) return w; }
    if (pri === 'strongest') { var s = maxBy(enemies, function (e) { return e.maxHp || e.arch.maxHp; }); if (dist(self, s) <= reach) return s; }
    return nearest;                                // 기본: 가장 가까운 적
  }

  /**
   * 역할군에 해당하는 살아있는 적들 (없으면 null).
   * exceptTrait이 주어지면 그 특성을 가진 적은 **제외**한다 — 예외 교리의 실행부.
   * (예: "지원형 우선 제거, 단 자폭(volatile)하는 적은 제외")
   */
  function rolePool(enemies, role, exceptTrait) {
    if (!role) return null;
    var p = enemies.filter(function (e) {
      if (e.arch.role !== role) return false;
      if (exceptTrait && hasTrait(e, exceptTrait)) return false;
      return true;
    });
    return p.length ? p : null;
  }

  /**
   * "무시하고 지나가" — 피할 역할군을 뺀 적들. 그 역할군만 남았으면 그대로 싸운다
   * (피하라는 말이 "지라"는 뜻은 아니다).
   */
  function withoutRole(enemies, role) {
    if (!role) return enemies;
    var rest = enemies.filter(function (e) { return e.arch.role !== role; });
    return rest.length ? rest : enemies;
  }

  /** 팀 공용 화력집중 타겟: "교전 중인 적 중 최저 HP"를 몰아친다 (역할군/우선순위 우대) */
  function computeTeamFocus(teamUnits, enemies, policy) {
    var living = alive(teamUnits);
    if (!living.length || !enemies.length) return null;
    enemies = withoutRole(enemies, policy.targetAvoid);
    var engaged = enemies.filter(function (e) {
      return living.some(function (a) { return dist(a, e) < a.arch.attackRange + 40; });
    });
    var pool = engaged.length ? engaged : enemies;
    // ★ 역할군 우선 (Doctrine) — 예외 특성은 제외
    var rp = rolePool(pool, policy.targetRole, policy.targetExcept)
          || rolePool(enemies, policy.targetRole, policy.targetExcept);
    if (rp) return minBy(rp, function (e) { return e.hp; });
    if (policy.targetPriority === 'healer') {
      var h = pool.filter(function (e) { return e.arch.healer; });
      if (h.length) return minBy(h, function (e) { return e.hp; });
    } else if (policy.targetPriority === 'archer') {
      var ar = pool.filter(function (e) { return e.arch.key === 'archer'; });
      if (ar.length) return minBy(ar, function (e) { return e.hp; });
    } else if (policy.targetPriority === 'strongest') {
      return maxBy(pool, function (e) { return e.maxHp || e.arch.maxHp; });  // 보스 등 최대 체력 우선
    }
    return minBy(pool, function (e) { return e.hp; });   // 기본: 교전 중 최저 HP
  }

  /** 포위 판정: 적 attacker가 근접 반경 안에 2명 이상 */
  function isSurrounded(unit, enemies, radius) {
    var n = 0;
    for (var i = 0; i < enemies.length; i++)
      if (dist(unit, enemies[i]) < radius) n++;
    return n >= 2;
  }

  function minBy(arr, f) {
    var best = arr[0], bv = f(arr[0]);
    for (var i = 1; i < arr.length; i++) { var v = f(arr[i]); if (v < bv) { bv = v; best = arr[i]; } }
    return best;
  }
  function maxBy(arr, f) {
    var best = arr[0], bv = f(arr[0]);
    for (var i = 1; i < arr.length; i++) { var v = f(arr[i]); if (v > bv) { bv = v; best = arr[i]; } }
    return best;
  }

  global.CommanderUnits = {
    ARCHETYPES: ARCHETYPES, ROLES: ROLES, TRAITS: TRAITS,
    hasTrait: hasTrait, fieldHasTrait: fieldHasTrait,
    buffMul: buffMul, rolePool: rolePool, withoutRole: withoutRole,
    dist: dist, alive: alive, canAttack: canAttack,
    chooseTarget: chooseTarget, computeTeamFocus: computeTeamFocus,
    isSurrounded: isSurrounded, minBy: minBy, maxBy: maxBy
  };
})(typeof window !== 'undefined' ? window : globalThis);
