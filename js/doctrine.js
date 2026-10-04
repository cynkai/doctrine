/* =============================================================================
 * doctrine.js — ★ 이 게임의 심장
 * -----------------------------------------------------------------------------
 *   Player Prompt → Intent Extraction → Doctrine Generator → Doctrine Memory
 *
 * 플레이어의 자연어 명령은 일회성 행동이 아니다. AI는 그 명령의 "의도"를 추론하고,
 * 영구적인 전술 교리로 일반화한다.
 *
 * ★ 교리는 '패턴'이 아니라 '원리'다.
 *   ❌ "힐러를 먼저 공격한다"                        (유닛 이름 암기)
 *   ⭕ "적 전력을 증폭하는 지원형이 있으면 먼저 제거한다"  (전장에 대한 술어)
 *
 * 그래서 교리는 두 부분을 가진다:
 *   condition — 이 전장에서 교리가 발동할 조건 (예: amplifier 특성을 가진 적이 존재)
 *   action    — 발동 시 무엇을 할지 (예: role=support 우선, 단 volatile은 제외)
 *
 * 이 구조가 만드는 세 가지 순간:
 *   ① 일반화   — 힐러가 없어도 버퍼(같은 support·amplifier)를 친다
 *   ② 조건부   — 증폭형이 아예 없는 전장에서는 교리가 발동하지 않는다
 *   ③ 예외     — volatile(자폭)이면 교리를 적용하는 것이 오히려 손해임을 배운다
 *
 * 계약: analyze(ctx) -> Promise<{kind, analysis, doctrine?, scores?}>
 *   kind = 'new' | 'exception' | 'report'   ← null을 반환하지 않는다.
 *          ('report'는 배울 게 없을 때 신뢰도만 보고 — 화면이 죽지 않는다)
 * 로컬(규칙 기반)으로 동작하고, 프록시가 살아있으면 실제 LLM으로 자동 승격한다.
 * ========================================================================== */
(function (global) {
  'use strict';

  var ROLE_LABEL = { frontline: '전열형', ranged: '원거리형', support: '지원형', elite: '정예형' };
  var TRAIT_LABEL = { amplifier: '전력 증폭', volatile: '자폭' };

  /* ---- 의도 카탈로그: 명령 표현 → 의도 → 일반화된 원리 ---------------------- */
  var INTENTS = [
    {
      // ⚠ 폴백은 **게임 용어만** 잡는다. 구어체("쟤 하나 때문에 안 죽잖아")를 잡으려고
      //   정규식에 그 문장을 박아 넣지 마라. 그건 시험 문제를 베끼는 것이고,
      //   폴백이 LLM인 척하게 만들며, "왜 LLM인가"의 답을 스스로 지운다.
      //   임의의 자연어 이해는 LLM의 몫이다(/api/intent).
      role: 'support',
      match: /(힐러|치유|회복|버퍼|지원|heal|support|buff)/i,
      requires: 'amplifier',
      intent: '적의 회복·강화 지원을 차단해 지속력을 무너뜨린다',
      name: '증폭형 우선 제거',
      // ★ 유닛 이름이 아니라 원리로 서술한다
      rule: '적 전력을 증폭하는 지원형(회복·강화)이 있으면 최우선으로 제거한다',
      why: '회복 차단'
    },
    {
      role: 'ranged',
      match: /(궁수|원거리|사수|저격|archer|ranged)/i,
      requires: null,
      intent: '적의 원거리 화력을 먼저 끊어 피해량을 줄인다',
      name: '원거리형 우선 제거',
      rule: '원거리형 적을 최우선으로 제거한다',
      why: '화력 차단'
    },
    {
      role: 'elite',
      match: /(보스|우두머리|정예|가장\s*강한|강한\s*적|boss|elite)/i,
      requires: null,
      intent: '적의 핵심 전력을 먼저 무너뜨린다',
      name: '정예형 우선 제거',
      rule: '정예형(보스) 적을 최우선으로 제거한다',
      why: '핵심 격파'
    },
    {
      role: 'frontline',
      match: /(전사|탱커|근접|전열|warrior|tank|frontline)/i,
      requires: null,
      intent: '적의 전열을 먼저 무너뜨려 진형을 붕괴시킨다',
      name: '전열형 우선 제거',
      rule: '전열형 적을 최우선으로 제거한다',
      why: '진형 붕괴'
    }
  ];

  /** 종성(받침) 코드. 없으면 0, ㄹ이면 8. 한글이 아니면 -1 */
  function batchim(word) {
    var s = word || '', c = s.charCodeAt(s.length - 1);
    if (!(c >= 0xAC00 && c <= 0xD7A3)) return -1;
    return (c - 0xAC00) % 28;
  }
  /** 을/를 · 이/가 — 교리 이름이 가변이므로 "제거을" 같은 오타를 막는다 */
  function josa(word, withBatchim, withoutBatchim) {
    var b = batchim(word);
    return b > 0 ? withBatchim : withoutBatchim;
  }
  /** 으로/로 — ㄹ 받침은 '로'를 쓴다 (서울로, 차단으로, 붕괴로) */
  function josaRo(word) {
    var b = batchim(word);
    return (b > 0 && b !== 8) ? '으로' : '로';
  }

  function matchIntent(command) {
    for (var i = 0; i < INTENTS.length; i++)
      if (INTENTS[i].match.test(command || '')) return INTENTS[i];
    return null;
  }

  function observedRole(battle) {
    var k = (battle && battle.killedRoles) || [];
    return k.length ? k[0] : null;
  }

  /* ---- 신뢰도(Doctrine Score) ---------------------------------------------
   * 교리는 만들어진 뒤에도 계속 평가받는다. 사용 횟수·성공률을 누적해
   * "이 교리를 얼마나 믿을 수 있는가"를 숫자로 보여준다.
   * 신뢰도가 떨어지는 순간이 곧 "예외가 필요하다"는 신호다.
   * --------------------------------------------------------------------- */
  function confidence(d) {
    var s = d.score || { uses: 0, wins: 0 };
    if (!s.uses) return null;
    return Math.round(s.wins / s.uses * 100);
  }
  function scoreLine(d) {
    var s = d.score || { uses: 0, wins: 0, losses: 0 };
    var c = confidence(d);
    return { name: d.name, uses: s.uses, wins: s.wins, losses: s.losses, confidence: c };
  }

  /* ---- 계보(Lineage) — 교리의 '진화'를 연출이 아니라 기록으로 보여주기 위한 것 ----
   * ⚠ 실제로 일어나지 않은 추상화 단계를 지어내지 마라. 그건 "UI만 AI"다.
   *   우리 시스템에서 실제로 일어나는 추상화 사다리는 이것뿐이고, 이것이면 충분하다:
   *
   *   구어체("쟤 하나 때문에 안 죽잖아")  →  의도("회복 차단")
   *      →  원리("증폭형이 있으면 우선 제거")  →  원리+예외("단, 자폭은 제외")
   *
   * 각 단계는 그 일이 **실제로 일어난 시점에** 기록된다. 렌더러는 기록을 읽을 뿐이다.
   * ------------------------------------------------------------------------- */
  function mkLineage(command, why, rule, stageName) {
    var out = [];
    if (command && command.trim())
      out.push({ step: 'command', label: '당신의 명령', text: '“' + command.trim() + '”', stage: stageName });
    if (why) out.push({ step: 'intent', label: 'AI가 읽은 의도', text: why });
    out.push({ step: 'rule', label: '일반화된 교리', text: rule });
    return out;
  }

  function mkDoctrine(spec, ctx, observed) {
    return {
      id: 'doc_' + spec.role,
      name: spec.name,
      rule: spec.rule,
      intent: spec.intent,
      why: spec.why,
      lineage: mkLineage(ctx.command, spec.why, spec.rule, ctx.stageName),
      // ★ 원리의 조건부: 이 특성을 가진 적이 전장에 있을 때만 발동
      condition: spec.requires ? { requiresTrait: spec.requires } : null,
      action: { targetRole: spec.role, focusFire: true, exceptTrait: null },
      score: { uses: 0, wins: 0, losses: 0 },
      reason: (ctx.command ? '플레이어는 "' + ctx.command + '"라고 지시했고, 실제 전투에서 '
                           : '플레이어는 이번 전투에서 ')
        + (observed ? (ROLE_LABEL[observed] || observed) + '을 먼저 제거했습니다. '
                    : '해당 대상을 우선했습니다. ')
        + '이 선택의 의도를 **' + spec.why + '**' + josaRo(spec.why) + ' 판단했습니다.',
      from: { command: ctx.command, stage: ctx.stageName },
      status: 'proposed'
    };
  }

  /* ---- 예외 교리 ----------------------------------------------------------
   * 기존 교리를 적용했는데 실패했고, 그 원인이 특정 특성(volatile 등)이라면
   * "교리 자체는 옳지만 이 특성에는 적용하지 않는다"를 배운다.
   * 이것이 '일반화의 한계 인식' — 암기한 규칙을 맹신하지 않는다는 증거다.
   * --------------------------------------------------------------------- */
  function mkException(base, trait, ctx) {
    var tl = TRAIT_LABEL[trait] || trait;
    return {
      id: base.id + '_except_' + trait,
      name: base.name + ' — 예외',
      rule: base.rule + ' 단, ' + tl + ' 특성을 가진 적은 우선 대상에서 제외한다',
      intent: base.intent + ' 다만 역효과가 나는 대상은 제외한다',
      why: tl + ' 역효과',
      // 원본 교리의 계보를 이어받고, 이번에 배운 예외를 한 칸 더 쌓는다
      lineage: (base.lineage || []).concat([{
        step: 'exception', label: '예외 학습', stage: ctx.stageName,
        text: '단, ' + tl + ' 특성을 가진 적은 제외한다'
      }]),
      condition: base.condition,
      action: { targetRole: base.action.targetRole, focusFire: true, exceptTrait: trait },
      score: { uses: 0, wins: 0, losses: 0 },
      reason: '교리 **' + base.name + '**' + josa(base.name, '을', '를') + ' 적용했으나 패배했습니다. 제거한 대상이 '
        + '**' + tl + '** 특성을 가지고 있었고, 처치 순간의 폭발이 아군에게 치명적이었습니다. '
        + '교리 자체는 유효하지만 **이 특성에는 예외**가 필요하다고 판단했습니다.',
      from: { command: ctx.command, stage: ctx.stageName },
      replaces: base.id,
      status: 'proposed'
    };
  }

  /** 이번 전투에서 교리를 적용했다가 역효과를 본 특성을 찾는다 */
  function findBackfire(ctx) {
    var b = ctx.battle || {};
    if (b.won) return null;                       // 이겼으면 예외가 필요 없다
    var fired = b.firedDoctrineId;
    if (!fired) return null;                      // 교리를 안 썼으면 교리 탓이 아니다
    var traits = b.backfireTraits || [];          // 게임이 관측한 역효과 특성
    return traits.length ? traits[0] : null;
  }

  /* ---- 로컬 분석기 (규칙 기반 폴백) ---------------------------------------- */
  function analyzeLocal(ctx) {
    var existing = ctx.existing || [];
    var scores = existing.map(scoreLine);

    // ① 예외 학습이 최우선 — 교리가 실패한 판이라면 그게 가장 중요한 교훈이다
    var trait = findBackfire(ctx);
    if (trait) {
      var base = existing.filter(function (d) { return d.id === ctx.battle.firedDoctrineId; })[0];
      if (base && !base.action.exceptTrait) {
        return Promise.resolve({
          kind: 'exception',
          analysis: '교리를 적용했지만 패배했습니다. **' + (TRAIT_LABEL[trait] || trait)
            + '** 특성이 교리의 전제를 깨뜨렸습니다. 규칙을 버리는 대신 **예외**를 학습합니다.',
          doctrine: mkException(base, trait, ctx),
          scores: scores
        });
      }
    }

    // ② 새 교리 — ★ 의도는 오직 '명령'에서만 추론한다.
    //   죽은 순서로 의도를 역추론하면 안 된다: 명령이 없으면 AI는 근접 타겟팅을 하고,
    //   전사가 앞줄에 있으니 전사가 먼저 죽는다. 그건 플레이어의 '선택'이 아니라 '위치 물리'다.
    //   그걸 "진형 붕괴 의도"로 읽으면 AI가 없는 의미를 지어내는 것 = 신뢰를 잃는다.
    //   죽은 순서는 근거(reason)를 보강하는 정황일 뿐, 추론의 출처가 아니다.
    var spec = matchIntent(ctx.command);
    var observed = observedRole(ctx.battle);
    var dup = spec && existing.some(function (d) { return d.action && d.action.targetRole === spec.role; });
    if (spec && !dup) {
      return Promise.resolve({
        kind: 'new',
        analysis: '플레이어는 이번 전투에서 ' + (ROLE_LABEL[spec.role] || spec.role)
          + ' 대상을 우선했습니다. 단순한 대상 지정이 아니라 **' + spec.why + '**이라는 의도로 해석됩니다.',
        doctrine: mkDoctrine(spec, ctx, observed),
        scores: scores
      });
    }

    // ③ 배울 게 없으면 신뢰도를 보고한다 (null을 반환하지 않는다 — 화면이 죽지 않도록)
    return Promise.resolve({ kind: 'report', analysis: reportText(scores, ctx), scores: scores });
  }

  function reportText(scores, ctx) {
    var used = scores.filter(function (s) { return s.uses > 0; });
    // 명령도 없고 발동한 교리도 없었다면 — 배울 게 없다고 정직하게 말한다.
    // (죽은 순서를 근거로 의도를 지어내지 않는다)
    if (!used.length) {
      return (ctx.command || '').trim()
        ? '이번 명령에서 일반화할 만한 의도를 찾지 못했습니다. 대상이나 우선순위를 지시해 보세요.'
        : '이번 전투에는 명령도, 발동한 교리도 없었습니다. AI는 기본 교전(가장 가까운 적)을 수행했을 뿐이므로 **배울 것이 없습니다.**';
    }
    var top = used[0];
    var base = '기존 교리 **' + top.name + '**' + josa(top.name, '을', '를') + ' 적용했고, 이번에도 유효했습니다.';
    if (top.confidence != null)
      base += ' 누적 ' + top.uses + '회 사용 · ' + top.wins + '회 성공 — 신뢰도 **' + top.confidence + '%**.';
    return base + ' 새로 배울 것은 없습니다.';
  }

  /* ---- LLM 어댑터 (프록시 살아있으면 승격, 동일 계약) ------------------------ */
  function analyzeLLM(ctx) {
    return fetch('/api/doctrine', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: ctx.command, stage: ctx.stageName, battle: ctx.battle,
        existing: (ctx.existing || []).map(function (d) {
          return { id: d.id, name: d.name, rule: d.rule, role: d.action.targetRole,
            exceptTrait: d.action.exceptTrait, confidence: confidence(d), uses: (d.score || {}).uses };
        }),
        roles: Object.keys(ROLE_LABEL).map(function (r) { return { key: r, label: ROLE_LABEL[r] }; }),
        traits: Object.keys(TRAIT_LABEL).map(function (t) { return { key: t, label: TRAIT_LABEL[t] }; })
      })
    }).then(function (r) { if (!r.ok) throw new Error('proxy ' + r.status); return r.json(); })
      .then(function (res) { return normalizeLLM(res, ctx); });
  }

  /** LLM 응답을 게임이 실행 가능한 교리로 정규화. 게임 규칙 밖의 값은 거절한다. */
  function normalizeLLM(res, ctx) {
    var existing = ctx.existing || [];
    var scores = existing.map(scoreLine);
    var d = res && res.doctrine;

    if (!d || !d.role || !ROLE_LABEL[d.role]) {
      // LLM이 "배울 게 없다"고 판단 → 신뢰도 보고로 대체 (화면이 죽지 않는다)
      return { kind: 'report', analysis: res && res.analysis ? res.analysis : reportText(scores, ctx), scores: scores };
    }
    if (d.exceptTrait && !TRAIT_LABEL[d.exceptTrait]) d.exceptTrait = null;   // 모르는 특성은 무시

    var isException = !!d.exceptTrait;
    var dup = existing.some(function (x) {
      return x.action.targetRole === d.role && x.action.exceptTrait === (d.exceptTrait || null);
    });
    if (dup) return { kind: 'report', analysis: reportText(scores, ctx), scores: scores };

    var base = existing.filter(function (x) { return x.action.targetRole === d.role && !x.action.exceptTrait; })[0];
    // 계보 — LLM이 실제로 낸 의도/규칙으로 쌓는다 (지어낸 단계를 넣지 않는다)
    var lineage;
    if (isException && base) {
      lineage = (base.lineage || []).concat([{
        step: 'exception', label: '예외 학습', stage: ctx.stageName,
        text: '단, ' + (TRAIT_LABEL[d.exceptTrait] || d.exceptTrait) + ' 특성을 가진 적은 제외한다'
      }]);
    } else {
      lineage = mkLineage(ctx.command, d.why, d.rule, ctx.stageName);
    }
    return {
      kind: isException ? 'exception' : 'new',
      analysis: res.analysis,
      scores: scores,
      doctrine: {
        id: 'doc_' + d.role + (d.exceptTrait ? '_except_' + d.exceptTrait : ''),
        name: d.name, rule: d.rule, intent: d.intent, why: d.why || '',
        lineage: lineage,
        condition: d.requiresTrait && TRAIT_LABEL[d.requiresTrait] ? { requiresTrait: d.requiresTrait } : null,
        action: { targetRole: d.role, focusFire: true, exceptTrait: d.exceptTrait || null },
        score: { uses: 0, wins: 0, losses: 0 },
        reason: d.reason,
        from: { command: ctx.command, stage: ctx.stageName },
        replaces: isException && base ? base.id : null,
        status: 'proposed'
      }
    };
  }

  /* ---- Intent Extraction (전투 전) ----------------------------------------
   * 플레이어의 **임의의 자연어**를 이번 전투의 정책으로 번역한다.
   * 정규식은 사전에 있는 표현만 잡는다. LLM은 "쟤 하나 때문에 안 죽잖아"도 이해한다.
   * 사람은 사전에 있는 말로 말하지 않는다 — 이게 LLM이 아니면 안 되는 이유다.
   *
   * 계약: interpret(command, ctx) -> Promise<{understood, set{}, rules[], why, source}>
   *   set = brain.js의 정책 조각과 같은 모양 → 게임 루프는 출처를 알 필요가 없다.
   * ---------------------------------------------------------------------- */
  function interpretLocal(command) {
    var Brain = global.CommanderBrain;
    var frag = Brain.parseFragment(command || '');
    var set = frag.set || {};
    // 정규식이 잡은 유닛 타입 우선순위를 역할군으로 승격 (교리와 같은 언어로)
    var spec = matchIntent(command);
    if (spec) set.targetRole = spec.role;
    return {
      understood: frag.matched > 0 || !!spec,
      set: set, rules: frag.rules || [],
      why: spec ? spec.why : '', source: 'local'
    };
  }

  /** 0~1 비율. LLM이 퍼센트(60)로 내면 0.6으로 읽는다 — 1로 잘리면 체력이 가득해도 후퇴한다. */
  function fraction(v) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    if (v > 1) v = v / 100;
    return Math.max(0, Math.min(1, v));
  }

  function interpretLLM(command, ctx) {
    return fetch('/api/intent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        command: command,
        enemies: (ctx && ctx.enemies) || [],
        roles: Object.keys(ROLE_LABEL).map(function (r) { return { key: r, label: ROLE_LABEL[r] }; }),
        traits: Object.keys(TRAIT_LABEL).map(function (t) { return { key: t, label: TRAIT_LABEL[t] }; })
      })
    }).then(function (r) { if (!r.ok) throw new Error('proxy ' + r.status); return r.json(); })
      .then(intentFromLLM);
  }

  /** /api/intent 응답 → 게임 정책 조각. 게임이 모르는 값은 버리고, 비율은 0~1로 맞춘다. */
  function intentFromLLM(res) {
    if (!res || !res.understood) return { understood: false, set: {}, rules: [], why: '', source: 'llm' };
    var set = {};
    if (res.targetRole && ROLE_LABEL[res.targetRole]) set.targetRole = res.targetRole;
    if (res.exceptTrait && TRAIT_LABEL[res.exceptTrait]) set.targetExcept = res.exceptTrait;
    if (res.avoidRole && ROLE_LABEL[res.avoidRole] && res.avoidRole !== set.targetRole) set.targetAvoid = res.avoidRole;
    if (res.focusFire) set.focusFire = true;
    if (res.kite) set.kite = true;
    if (res.aggression != null) set.aggression = fraction(res.aggression);
    if (res.retreatHpPct != null) set.retreatHpPct = fraction(res.retreatHpPct);
    return {
      understood: true, set: set,
      rules: (res.rules || []).slice(0, 3),
      why: res.why || '', source: 'llm'
    };
  }

  function eligibleDoctrines(doctrines, enemies) {
    var U = global.CommanderUnits;
    return (doctrines || []).filter(function (d) {
      if (d.status !== 'accepted' || !d.action) return false;
      if (d.condition && d.condition.requiresTrait) {
        if (!enemies) return false;
        return U.fieldHasTrait(enemies, d.condition.requiresTrait);
      }
      return true;
    });
  }

  function normalizedConfidence(d) {
    var c = confidence(d);
    return c == null ? 50 : c;
  }

  function compareDoctrines(a, b) {
    var sa = a.condition && a.condition.requiresTrait ? 1 : 0;
    var sb = b.condition && b.condition.requiresTrait ? 1 : 0;
    if (sa !== sb) return sb - sa;
    return normalizedConfidence(b) - normalizedConfidence(a);
  }

  function actionSignature(d) {
    return [
      d.action.targetRole || '',
      d.action.exceptTrait || '',
      d.action.focusFire ? '1' : '0'
    ].join('|');
  }

  function selectDoctrine(doctrines, enemies, resolutions) {
    var eligible = eligibleDoctrines(doctrines, enemies);
    if (!eligible.length) return { doctrine: null, conflict: null };

    eligible.sort(compareDoctrines);
    var legacyWinner = eligible[0];
    var contenders = eligible.filter(function (d) { return compareDoctrines(d, legacyWinner) === 0; });
    if (contenders.length < 2) return { doctrine: legacyWinner, conflict: null };

    var firstAction = actionSignature(contenders[0]);
    var differs = contenders.some(function (d) { return actionSignature(d) !== firstAction; });
    if (!differs) return { doctrine: legacyWinner, conflict: null };

    var contenderIds = contenders.map(function (d) { return d.id; });
    var key = contenderIds.slice().sort().join('|');
    var saved = resolutions && resolutions[key];
    var resolvedWinner = null;
    if (saved && saved.winnerId) {
      resolvedWinner = contenders.filter(function (d) { return d.id === saved.winnerId; })[0] || null;
    }

    return {
      doctrine: resolvedWinner || legacyWinner,
      conflict: {
        key: key,
        contenderIds: contenderIds,
        legacyWinnerId: legacyWinner.id,
        resolvedWinnerId: resolvedWinner ? resolvedWinner.id : null
      }
    };
  }

  function applyDoctrine(policy, doctrine) {
    if (!doctrine) return;
    policy.targetRole = doctrine.action.targetRole;
    policy.targetExcept = doctrine.action.exceptTrait || null;
    if (doctrine.action.focusFire) policy.focusFire = true;
  }

  function applyToDetailed(policy, doctrines, enemies, resolutions) {
    var result = selectDoctrine(doctrines, enemies, resolutions);
    applyDoctrine(policy, result.doctrine);
    return result;
  }

  var useLLM = false;
  var backendLabel = 'LOCAL · 규칙 기반';   // 화면에 정직하게 표시된다. 규칙 기반을 LLM인 척하지 않는다.

  global.Doctrine = {
    ROLE_LABEL: ROLE_LABEL,
    TRAIT_LABEL: TRAIT_LABEL,
    confidence: confidence,
    intentFromLLM: intentFromLLM,

    /** 명령문이 가리키는 역할군 (이번 전투의 명시 명령은 교리보다 우선) */
    roleOfCommand: function (text) { var s = matchIntent(text); return s ? s.role : null; },

    analyze: function (ctx) {
      if (useLLM) return analyzeLLM(ctx).catch(function () { return analyzeLocal(ctx); });
      return analyzeLocal(ctx);
    },

    /** ★ 자연어 명령 → 이번 전투의 정책. LLM 실패 시 정규식으로 자동 강등. */
    interpret: function (command, ctx) {
      if (!command || !command.trim())
        return Promise.resolve({ understood: false, set: {}, rules: [], why: '', source: useLLM ? 'llm' : 'local' });
      if (useLLM) return interpretLLM(command, ctx).catch(function () { return interpretLocal(command); });
      return Promise.resolve(interpretLocal(command));
    },
    /** 동기 정규식 해석 — 헤드리스 시뮬레이터용(LLM을 기다릴 수 없는 경로) */
    interpretSync: function (command) {
      if (!command || !command.trim()) return { understood: false, set: {}, rules: [], why: '', source: 'local' };
      return interpretLocal(command);
    },

    /**
     * ★ 승인된 교리를 정책에 적용 — 다음 전투에서 AI가 스스로 따르는 규칙.
     *
     * 교리들은 targetRole을 두고 서로 **충돌**한다(동시에 두 역할군을 최우선할 수 없다).
     * 그러므로 AI는 이 전장에 맞는 교리 하나를 **선택**해야 한다. 아무거나 덮어쓰면 안 된다.
     *
     * 선택 규칙:
     *   ① 조건 판정 — condition이 있으면 전장을 보고 발동 자격을 가린다.
     *      (증폭형이 없는 전장에서 "증폭형 우선" 교리는 애초에 후보가 아니다)
     *   ② 구체성 — 조건이 이 전장에 들어맞는 교리가, 무조건 교리보다 우선한다.
     *   ③ 신뢰도 — 그다음은 성적이 좋은 교리를 믿는다.
     *
     * @param {array} enemies 이번 전장의 적 목록 (조건 판정용)
     * @returns {object|null} 실제로 발동한 교리 (없으면 null)
     */
    applyTo: function (policy, doctrines, enemies) {
      return applyToDetailed(policy, doctrines, enemies, null).doctrine;
    },

    /** v1 선택 결과에 Shadow Conflict 메타데이터를 더한 신규 API. */
    applyToDetailed: applyToDetailed,

    backend: function () { return useLLM ? 'llm' : 'local'; },
    backendLabel: function () { return backendLabel; },
    probe: function () {
      return fetch('/api/health')
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (info) {
          useLLM = !!info;
          if (info) backendLabel = String(info.provider || 'llm').toUpperCase() + ' · ' + info.model;
          return useLLM;
        })
        .catch(function () { useLLM = false; return false; });
    }
  };
})(window);
