/* =============================================================================
 * game.js — 시뮬레이션 루프 · 이동 AI · 렌더링 · UI 연결
 * -----------------------------------------------------------------------------
 * 정책(policy)이 결정한 "의도"를 매 프레임 물리적 행동으로 실행한다.
 * 정책은 CommanderBrain.parseDirective()가 자연어 지시문에서 생성.
 * ========================================================================== */
(function () {
  'use strict';
  var Brain = window.CommanderBrain;
  var U = window.CommanderUnits;
  var A = U.ARCHETYPES;

  var canvas, ctx, W = 900, H = 600;   // 실제 크기는 컨테이너에 맞춰 갱신
  var state = null;      // 현재 전투 상태
  var speed = 1;         // 배속
  var running = false;
  var lastTs = 0;
  var enemyPolicy = null;

  // 시각 효과 레이어
  var projectiles = [];  // {x,y, tx,ty, team, kind, t, dur}
  var particles = [];    // {x,y, vx,vy, life, max, col, r}
  var shake = 0;         // 화면 흔들림 강도
  function spawnParticles(x, y, col, n, spd) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * Math.PI * 2, s = spd * (0.4 + Math.random() * 0.9);
      particles.push({ x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s,
        life: 0, max: 0.4 + Math.random() * 0.5, col: col, r: 1.5 + Math.random() * 2.5 });
    }
  }

  // ★ 예선 빌드 스코프: 증명할 것은 단 하나 — "명령은 영구적 사고방식(Doctrine)이 된다".
  //   나머지 시스템은 인과를 흐리므로 끈다. (본선/GitHub용으로 코드는 보존)
  var FEATURES = { events: false, adaptiveEnemy: false, warCouncil: false };

  // 플레이어 편성(고정): 전사2 · 궁수2 · 힐러1
  var PLAYER_COMP = ['warrior', 'warrior', 'archer', 'archer', 'healer'];

  // 적 정책 헬퍼
  function pol(o) {
    var p = Brain.defaultPolicy();
    p.targetPriority = o.targetPriority || 'nearest';
    p.focusFire = !!o.focusFire;
    p.aggression = o.aggression != null ? o.aggression : 0.5;
    p.retreatHpPct = o.retreatHpPct || 0;
    p.kite = !!o.kite;
    p._rules = o.rules || [];
    return p;
  }

  // ===== 스테이지 — 오직 "교리 일반화"를 증명하기 위해 설계됨 =================
  //  ① 힐러 있음: 플레이어가 "힐러 먼저" 명령 → 교리 생성
  //  ② 힐러 있음: 명령 없이 교리가 스스로 적용됨 (기억의 증명)
  //  ③ 힐러 없음 · 버퍼 등장: 같은 교리가 버퍼를 타격 (일반화의 증명 — "어?")
  var ENEMY_AI = { targetPriority: 'nearest', focusFire: false, aggression: 0.5, retreatHpPct: 0,
    rules: ['각자 가장 가까운 적 교전', '화력 분산'] };

  var STAGES = [
    {
      id: 1, name: '첫 교전', sub: 'FIRST CONTACT', diff: 1,
      brief: '적에 힐러가 있다. 자연어로 명령해 보라.',
      comp: ['warrior', 'warrior', 'archer', 'healer'], statMul: 0.85, policy: ENEMY_AI
    },
    {
      id: 2, name: '재확인', sub: 'RECALL', diff: 2,
      brief: '같은 편성. 이번엔 명령하지 않아도 된다 — AI가 교리를 기억한다.',
      comp: ['warrior', 'warrior', 'archer', 'healer'], statMul: 0.95, policy: ENEMY_AI
    },
    {
      id: 3, name: '증명', sub: 'THE PROOF', diff: 3, proof: true,
      brief: '적에 힐러가 없다. 대신 버퍼가 있다. AI는 무엇을 노릴까?',
      // 버퍼를 살려두면 적 전군이 +45%로 강해진다 → 교리가 "있으면 이기고 없으면 지는" 판.
      // 검증(각 26회): 교리 없음 = 승률 0% / 교리 적용 = 승률 100%. 교리가 승패를 가른다.
      comp: ['warrior', 'warrior', 'warrior', 'archer', 'buffer'], statMul: 0.85, policy: ENEMY_AI
    },
    {
      // ★ 교리가 틀리는 판. 세 판 동안 옳았던 규칙이 여기서 역효과를 낸다.
      //   AI는 규칙을 버리지 않고 **예외**를 배운다 = 일반화의 한계 인식.
      id: 4, name: '예외', sub: 'THE EXCEPTION', diff: 4, exception: true,
      brief: '적 지원형이 자폭한다. 배운 교리를 그대로 적용해도 될까?',
      // 검증(각 20회): 교리 맹신(지원형 우선) = 승률 0% / 예외 학습(자폭 제외) = 승률 100%.
      // 즉 이 판의 승패는 "AI가 자기 교리의 한계를 아는가"로 갈린다.
      comp: ['warrior', 'warrior', 'warrior', 'archer', 'bomber'], statMul: 0.85, policy: ENEMY_AI
    }
  ];

  // 대형 배치 — 역할별 열(전사 전방·궁수 후방·힐러 최후방·보스 최전방). 개수 가변.
  function layoutTeam(types, team) {
    var FX = { boss: 0.23, warrior: 0.20, archer: 0.11, healer: 0.055 };
    var cols = {};
    for (var i = 0; i < types.length; i++) { (cols[types[i]] = cols[types[i]] || []).push(i); }
    var posOut = new Array(types.length);
    Object.keys(cols).forEach(function (role) {
      var arr = cols[role], fx = FX[role] != null ? FX[role] : 0.16;
      var x = team === 'player' ? fx * W : (1 - fx) * W;
      var span = Math.min(H * 0.64, Math.max(1, arr.length) * 92);
      var step = span / arr.length;
      for (var k = 0; k < arr.length; k++) {
        var y = arr.length === 1 ? H / 2 : (H / 2 - span / 2 + step / 2 + k * step);
        posOut[arr[k]] = { x: x, y: y };
      }
    });
    return posOut;
  }

  function spawnTeam(team, policy, types, statMul) {
    statMul = statMul || 1;
    var mul = team === 'enemy' ? statMul : 1;
    var posArr = layoutTeam(types, team), units = [];
    for (var i = 0; i < types.length; i++) {
      var arch = A[types[i]], mh = Math.round(arch.maxHp * mul);
      units.push({
        id: team + i, team: team, arch: arch, policy: policy,
        x: posArr[i].x, y: posArr[i].y,
        hp: mh, maxHp: mh, dmgMul: mul,
        cd: Math.random() * 0.3, alive: true,
        target: null, retreating: false
      });
    }
    return units;
  }

  var enemyOverride = null; // (테스트) 적 정책 오버라이드
  var currentStage = 0;     // 0-index
  /**
   * @param {object} intent Doctrine.interpret()의 결과(LLM 또는 정규식). 없으면 정규식으로 자체 처리.
   */
  function newBattle(initialText, stageIdx, intent) {
    if (stageIdx != null) currentStage = stageIdx;
    var stage = STAGES[currentStage];
    enemyPolicy = pol(stage.policy);
    if (enemyOverride) for (var kk in enemyOverride) enemyPolicy[kk] = enemyOverride[kk];
    // ★ 해석기(LLM 우선, 정규식 폴백)가 이해한 조각을 1번 규칙으로.
    //   ⚠ 이해하지 못했어도 원문(initialText)은 절대 버리지 않는다 — 전투 후 LLM이 봐야 한다.
    // intent가 없으면(헤드리스 시뮬레이터 등) 정규식으로 동기 해석한다.
    if (!intent) intent = window.Doctrine.interpretSync(initialText || '');
    var frag0 = { set: intent.set || {}, rules: intent.rules || [],
      matched: intent.understood ? 1 : 0, text: initialText || '' };
    var stack = frag0.matched ? [frag0] : [];
    var effPolicy = Brain.composePolicy(stack);
    var enemy = spawnTeam('enemy', enemyPolicy, stage.comp, stage.statMul);
    // ★ 학습된 교리를 AI의 기본 사고방식으로 주입 (명령이 없어도 스스로 적용된다).
    //   전장(enemy)을 넘겨서 조건(condition)을 판정한다 — 증폭형이 없으면 발동하지 않는다.
    var doctrineResult = window.Doctrine.applyToDetailed(
      effPolicy, doctrines, enemy, doctrineConflictMemory.resolutions
    );
    var fired = doctrineResult.doctrine;
    var conflict = doctrineResult.conflict;
    // 이번 전투의 명시 명령이 교리보다 우선 (해석기가 대상을 읽어냈을 때).
    // ★ 명령이 교리를 덮어쓰면, 그 전투를 실제로 이끈 것은 명령이지 교리가 아니다.
    //   그래서 firedDoctrine을 비운다 — 안 그러면 Replay가 "안 쓰인 교리"를 보여준다(거짓).
    //   (또한 신뢰도는 '자율 적용'만 세야 한다. 명령받고 한 건 교리의 성적이 아니다.)
    if (intent.understood && intent.set && intent.set.targetRole) {
      effPolicy.targetRole = intent.set.targetRole;
      effPolicy.targetExcept = intent.set.targetExcept || null;
      fired = null;
      conflict = null;
    }
    var player = spawnTeam('player', effPolicy, PLAYER_COMP, 1);
    state = {
      player: player, enemy: enemy,
      all: player.concat(enemy),
      // ★ 원문 명령. 해석 실패해도 보존한다 — 전투 후 LLM이 이걸 보고 의도를 추론한다.
      //   (정규식이 문 앞에서 자연어를 버리면 LLM은 명령을 본 적조차 없게 된다)
      command: initialText || '',
      intent: intent,
      stage: currentStage, stack: stack, effPolicy: effPolicy,
      t: 0, maxT: stage.boss ? 90 : 70, over: false, winner: null,
      log: [], newKills: 0, stars: 0,
      firedDoctrine: fired,   // ★ 이번 전투에 실제로 발동한 교리 (신뢰도 채점 대상)
      doctrineConflict: conflict,
      backfireTraits: [],     // ★ 교리를 적용했다가 역효과를 본 특성 (예외 학습의 근거)
      killedRoles: [],        // ★ 교리 추론의 근거: 제거된 적 역할군 순서
      // 전장 이벤트
      hazards: [], zones: [], fog: null, nextEventT: 7, eventLog: [], toast: null,
      // 적 적응
      nextAdaptT: 9, adaptCount: 0, basePolicy: pol(stage.policy)
    };
    projectiles.length = 0; particles.length = 0; shake = 0;
  }

  // 해석된 의도를 규칙 스택에 추가(전투 중 실시간). 누적하여 정책 재구성.
  function pushIntent(text, intent) {
    if (!state) return false;
    state.stack.push({ set: intent.set || {}, rules: intent.rules || [], matched: 1, text: text });
    var np = Brain.composePolicy(state.stack);
    // ⚠ 스택만으로 재구성하면 교리가 심어둔 targetRole이 사라진다.
    //   newBattle과 같은 우선순위를 유지한다: 교리를 깔고, 명시 명령이 있으면 그것이 이긴다.
    var hasCmdRole = state.stack.some(function (f) { return f.set && f.set.targetRole; });
    if (!hasCmdRole) window.Doctrine.applyTo(np, doctrines, state.enemy);
    for (var k in np) state.effPolicy[k] = np[k];   // 유닛들이 참조하는 정책을 제자리 갱신
    return true;
  }
  // (테스트/하위호환) 정규식으로 즉시 규칙 추가
  function pushRule(text) {
    if (!state) return false;
    var frag = Brain.parseFragment(text);
    if (!frag.matched) return false;
    return pushIntent(text, { understood: true, set: frag.set, rules: frag.rules });
  }

  // ---- 진행도 (localStorage) -------------------------------------------------
  var progress = (function () { try { return JSON.parse(localStorage.getItem('commander_progress') || '{}'); } catch (e) { return {}; } })();
  function commitProgress(stageIdx, stars) {
    var id = STAGES[stageIdx].id;
    if ((progress[id] || 0) < stars) { progress[id] = stars; try { localStorage.setItem('commander_progress', JSON.stringify(progress)); } catch (e) {} }
  }
  function stageUnlocked(stageIdx) { return stageIdx === 0 || (progress[STAGES[stageIdx - 1].id] || 0) >= 1; }

  // ---- 사령관 통계 (종료 화면용) — 실제 플레이 경로에서만 누적 -------------------
  var cstats = (function () { try { return JSON.parse(localStorage.getItem('commander_stats') || '{}'); } catch (e) { return {}; } })();
  if (cstats.battles == null) cstats.battles = 0;
  if (cstats.orders == null) cstats.orders = 0;
  function saveStats() { try { localStorage.setItem('commander_stats', JSON.stringify(cstats)); } catch (e) {} }
  function bumpBattles() { cstats.battles++; saveStats(); }
  function bumpOrders() { cstats.orders++; saveStats(); }

  // ---- 시뮬레이션 스텝 -------------------------------------------------------
  function step(dt) {
    if (!state || state.over) return;
    state.t += dt;
    // 예선 빌드: 전장 이벤트/적 적응은 OFF. 인과를 흐리면 "AI가 교리를 적용했다"는
    // 증명이 죽는다. (코드는 남아 있고 FEATURES 플래그로 본선에서 되살릴 수 있다)
    if (FEATURES.events) processEvents(dt);
    if (FEATURES.adaptiveEnemy) adaptCheck();
    var fogMul = state.fog ? 0.62 : 1;   // 안개: 사거리 감소

    var pAlive = U.alive(state.player), eAlive = U.alive(state.enemy);
    var pFocus = U.computeTeamFocus(state.player, eAlive, state.player[0].policy);
    var eFocus = U.computeTeamFocus(state.enemy, pAlive, enemyPolicy);

    // 행동 순서를 매 프레임 교대 → 선행/후행(턴 순서) 편향 제거 (공정한 미러)
    state.frame = (state.frame || 0) + 1;
    var order = (state.frame % 2 === 0) ? state.all : state.all.slice().reverse();

    for (var i = 0; i < order.length; i++) {
      var u = order[i];
      if (!u.alive) continue;
      u.cd -= dt;

      var allies = u.team === 'player' ? state.player : state.enemy;
      var foes = u.team === 'player' ? eAlive : pAlive;
      var focus = u.team === 'player' ? pFocus : eFocus;
      var pol = u.policy;

      // ⚠ 폭격/붕괴 회피 (병종별 버퍼: 힐러가 가장 민감) — 최우선 행동
      if (pol.avoidHazards) {
        var buf = u.arch.healer ? 34 : u.arch.boss ? 10 : 22;
        var esc = dangerEscape(u, buf);
        if (esc) { u.retreating = false; moveToward(u, esc, dt, 1.15); continue; }
      }

      if (u.arch.healer) { actHealer(u, allies, foes, dt); continue; }
      if (!foes.length) continue;

      // 타겟 선정 (안개 시 사거리↓, 우선순위/집중은 닿는 범위 안에서만)
      var arng = u.arch.attackRange * fogMul;
      var reach = arng + 85;
      var tgt = U.chooseTarget(u, foes, pol, focus, reach);
      u.target = tgt;
      if (!tgt) continue;

      var d = U.dist(u, tgt);
      var hpPct = u.hp / u.maxHp;
      u.retreating = false;
      // 병종별 해석: 전사는 공격성 +(최전선), 궁수는 신중 유지
      var caggr = u.arch.key === 'warrior' ? Math.min(1, pol.aggression + 0.18) : pol.aggression;

      // 1) 후퇴 판정 — "아군 힐러 쪽으로 재집결"(힐 받고 재교전).
      var nearestFoe = U.minBy(foes, function (e) { return U.dist(u, e); });
      var threat = U.dist(u, nearestFoe);
      if (pol.retreatHpPct > 0 && hpPct < pol.retreatHpPct && threat < 190) {
        u.retreating = true;
        var healer = firstAliveOfType(allies, 'healer', u);
        if (healer && U.dist(u, healer) > 24) moveToward(u, healer, dt);
        else moveAway(u, nearestFoe, dt);
        if (u.arch.ranged && d <= arng && u.cd <= 0) doAttack(u, tgt);
        continue;
      }

      // 1.5) 집결(뭉치기): 아군 중심에서 멀면 끌어당김 (병종 공통, 전투 겸행)
      if (pol.regroup) {
        var cen = teamCentroid(allies, u);
        if (cen && U.dist(u, cen) > 70) moveToward(u, cen, dt, 0.7);
      }

      // 2) 호위 (근접 유닛이 지정 아군을 엄호)
      if (pol.protect && !u.arch.ranged) {
        var ward = firstAliveOfType(allies, pol.protect, u);
        if (ward) {
          var foeNearWard = U.minBy(foes, function (e) { return U.dist(ward, e); });
          if (foeNearWard && U.dist(ward, foeNearWard) < 85) {
            var mid = { x: (ward.x + foeNearWard.x) / 2, y: (ward.y + foeNearWard.y) / 2 };
            moveToward(u, mid, dt);
            if (U.dist(u, foeNearWard) <= arng && u.cd <= 0) doAttack(u, foeNearWard);
            continue;
          }
        }
      }

      // 3) 구출 (포위된 아군에게 이동)
      if (pol.rescue) {
        var victim = findSurroundedAlly(allies, foes, u);
        if (victim && U.dist(u, victim) > 40) { moveToward(u, victim, dt); continue; }
      }

      // 4) 카이팅 (원거리 거리 유지)
      if (u.arch.ranged && pol.kite) {
        if (d < u.arch.prefDist - 12) { moveAway(u, tgt, dt); }
        else if (d > arng) { moveToward(u, tgt, dt); }
        if (d <= arng && u.cd <= 0) doAttack(u, tgt);
        continue;
      }

      // 5) 기본 교전: 사거리까지 접근 후 공격 (전사=적극, 궁수=신중)
      if (d > arng) moveToward(u, tgt, dt, caggr < 0.3 ? 0.6 : (u.arch.key === 'warrior' && caggr > 0.8 ? 1.15 : 1));
      else if (u.cd <= 0) doAttack(u, tgt);
      if (u.arch.ranged && d < u.arch.prefDist - 20) moveAway(u, tgt, dt, 0.6);
    }

    resolveDamage();
    separate(dt);
    checkWin();
  }

  // ===== 전장 이벤트 (폭격 · 안개 · 붕괴) ======================================
  var EVENT_INTERVAL = 12;
  var HAZARD_KILLER = { team: 'hazard', arch: { label: '폭격' } };
  function processEvents(dt) {
    var hs = state.hazards, i;
    for (i = hs.length - 1; i >= 0; i--) {
      var h = hs[i]; h.t += dt;
      if (h.phase === 'warn' && h.t >= h.warnDur) { h.phase = 'blast'; h.t = 0; blastHazard(h); }
      else if (h.phase === 'blast' && h.t >= h.blastDur) hs.splice(i, 1);
    }
    var zs = state.zones;
    for (i = zs.length - 1; i >= 0; i--) { zs[i].t += dt; if (zs[i].t >= zs[i].dur) zs.splice(i, 1); }
    if (state.fog) { state.fog.t += dt; if (state.fog.t >= state.fog.dur) state.fog = null; }
    if (state.t >= state.nextEventT && state.t < state.maxT - 6) {
      triggerEvent();
      state.nextEventT = state.t + EVENT_INTERVAL + (Math.random() * 4 - 2);
    }
  }
  function randPos(margin) { margin = margin || 90; return { x: margin + Math.random() * (W - 2 * margin), y: margin + Math.random() * (H - 2 * margin) }; }
  function triggerEvent() {
    var roll = Math.random();
    if (roll < 0.52) eventAirstrike();
    else if (roll < 0.8) eventFog();
    else eventCollapse();
  }
  function eventAirstrike() {
    var n = 2 + Math.floor(Math.random() * 2);
    for (var i = 0; i < n; i++) { var p = randPos(80); state.hazards.push({ x: p.x, y: p.y, r: 58 + Math.random() * 22, phase: 'warn', t: 0, warnDur: 2.2, blastDur: 0.45 }); }
    logEvent('☄ 폭격 경고! 낙하 지점을 피하라 — "폭격 지대를 피해라"', 'bomb');
  }
  function eventFog() { state.fog = { t: 0, dur: 8 }; logEvent('🌫 짙은 안개 — 사거리 감소. 접근해 싸워라', 'fog'); }
  function eventCollapse() { var p = randPos(120); state.zones.push({ x: p.x, y: p.y, r: 70, t: 0, dur: 9 }); logEvent('⛌ 지형 붕괴 — 통행 불가 지대. "붕괴 지대를 피해라"', 'collapse'); }
  function blastHazard(h) {
    shake = Math.min(13, shake + 7); spawnParticles(h.x, h.y, '#ffb04a', 26, 160);
    for (var i = 0; i < state.all.length; i++) {
      var u = state.all[i]; if (!u.alive) continue;
      if (Math.hypot(u.x - h.x, u.y - h.y) < h.r) { u._dmg = (u._dmg || 0) + 40; u._lastHitBy = HAZARD_KILLER; }
    }
  }
  function logEvent(text, kind) { state.eventLog.push({ t: state.t, text: text, kind: kind }); if (running) showToast(text, kind); }

  // ===== 적 AI 적응 ===========================================================
  function adaptCheck() {
    if (state.t < state.nextAdaptT) return;
    state.nextAdaptT = state.t + 10;
    var p = state.effPolicy, np = pol(STAGES[state.stage].policy), msg = null, chips = np._rules.slice(0, 1);
    if (p.focusFire) { np.protect = 'healer'; np.targetPriority = 'weakest'; msg = '집중 포화 감지 → 산개·약한 유닛 노림'; chips = ['산개 대응', '약한 아군부터']; }
    if (p.targetPriority === 'healer') { np.protect = 'healer'; np.aggression = Math.min(1, (np.aggression || 0.6) + 0.15); msg = '힐러 저격 감지 → 힐러 사수·역돌격'; chips = ['힐러 사수', '역돌격']; }
    if (p.kite) { np.aggression = Math.min(1, (np.aggression || 0.6) + 0.28); np.focusFire = true; msg = '카이팅 감지 → 맹렬히 추격'; chips = ['맹렬 추격', '거리 좁힘']; }
    if (!msg) return;
    np._rules = chips;
    for (var k in np) enemyPolicy[k] = np[k];   // 유닛이 참조하는 적 정책을 제자리 갱신
    state.adaptCount++;
    logEvent('🧠 적 적응: ' + msg, 'adapt');
    if (running) renderChips(enemyPolicy, 'enemyRead', '적 부대 · 적응 ' + state.adaptCount + '회');
  }

  function teamCentroid(list, exclude) {
    var n = 0, cx = 0, cy = 0;
    for (var i = 0; i < list.length; i++) { var a = list[i]; if (a.alive && a !== exclude) { cx += a.x; cy += a.y; n++; } }
    return n ? { x: cx / n, y: cy / n } : null;
  }
  // 위험(폭격 경고/폭발 반경, 붕괴 지대) 안이면 바깥 탈출 지점 반환
  function dangerEscape(u, buf) {
    var best = null, bestPush = 0, i;
    for (i = 0; i < state.hazards.length; i++) {
      var h = state.hazards[i], d = Math.hypot(u.x - h.x, u.y - h.y), rr = h.r + buf;
      if (d < rr && (rr - d) > bestPush) { bestPush = rr - d; best = { x: u.x + (u.x - h.x) / (d || 1) * 90, y: u.y + (u.y - h.y) / (d || 1) * 90 }; }
    }
    for (i = 0; i < state.zones.length; i++) {
      var z = state.zones[i], d2 = Math.hypot(u.x - z.x, u.y - z.y), r2 = z.r + buf;
      if (d2 < r2 && (r2 - d2) > bestPush) { bestPush = r2 - d2; best = { x: u.x + (u.x - z.x) / (d2 || 1) * 90, y: u.y + (u.y - z.y) / (d2 || 1) * 90 }; }
    }
    return best;
  }

  function actHealer(u, allies, foes, dt) {
    var pol = u.policy;
    var hpPct = u.hp / u.maxHp;
    // 자기 보호: 위협 가까우면 후퇴
    if (foes.length) {
      var nf = U.minBy(foes, function (e) { return U.dist(u, e); });
      if (U.dist(u, nf) < 95 || (pol.retreatHpPct && hpPct < Math.max(pol.retreatHpPct, 0.4))) {
        u.retreating = true;
        moveAway(u, nf, dt);
      } else u.retreating = false;
    }
    // 치유 대상: 가장 다친 아군
    var wounded = allies.filter(function (a) { return a.alive && a !== u && a.hp < a.maxHp; });
    if (!wounded.length) {
      // 다친 아군 없으면 아군 무리 뒤로
      var core = allies.filter(function (a) { return a.alive && a !== u; });
      if (core.length) { var c = U.minBy(core, function (a) { return U.dist(u, a); }); if (!u.retreating) keepBehind(u, c, foes, dt); }
      return;
    }
    var patient = U.minBy(wounded, function (a) { return a.hp / a.maxHp; });
    var d = U.dist(u, patient);
    if (d > u.arch.healRange) { if (!u.retreating) moveToward(u, patient, dt); }
    if (d <= u.arch.healRange && u.cd <= 0) {
      patient._heal = (patient._heal || 0) + u.arch.heal * (u.dmgMul || 1);   // 프레임 끝 일괄(스탯배율 반영)
      u.cd = u.arch.attackCd;
      projectiles.push({ x: u.x, y: u.y, tx: patient.x, ty: patient.y, team: u.team, kind: 'heal', t: 0, dur: 0.2 });
      patient.healFlash = 0.25;
    }
  }

  // ---- 이동 헬퍼 -------------------------------------------------------------
  function moveToward(u, t, dt, mul) {
    mul = mul || 1;
    var dx = t.x - u.x, dy = t.y - u.y, L = Math.hypot(dx, dy) || 1;
    u.x += (dx / L) * u.arch.speed * mul * dt;
    u.y += (dy / L) * u.arch.speed * mul * dt;
    clamp(u);
  }
  function moveAway(u, t, dt, mul) {
    mul = mul || 1;
    var dx = u.x - t.x, dy = u.y - t.y, L = Math.hypot(dx, dy) || 1;
    u.x += (dx / L) * u.arch.speed * mul * dt;
    u.y += (dy / L) * u.arch.speed * mul * dt;
    clamp(u);
  }
  function keepBehind(u, ally, foes, dt) {
    if (!foes.length) { moveToward(u, ally, dt, 0.5); return; }
    var f = U.minBy(foes, function (e) { return U.dist(ally, e); });
    var dx = ally.x - f.x, dy = ally.y - f.y, L = Math.hypot(dx, dy) || 1;
    var spot = { x: ally.x + (dx / L) * 40, y: ally.y + (dy / L) * 40 };
    moveToward(u, spot, dt, 0.8);
  }
  function clamp(u) {
    var r = u.arch.radius;
    if (u.x < r) u.x = r; if (u.x > W - r) u.x = W - r;
    if (u.y < r) u.y = r; if (u.y > H - r) u.y = H - r;
  }
  // 겹침 방지(간단한 분리력) + 붕괴 지대 밀어내기(통행 불가)
  function separate(dt) {
    var a = U.alive(state.all), i, j;
    for (i = 0; i < a.length; i++) for (j = i + 1; j < a.length; j++) {
      var u = a[i], v = a[j], d = U.dist(u, v), min = u.arch.radius + v.arch.radius;
      if (d > 0 && d < min) {
        var push = (min - d) / 2, dx = (u.x - v.x) / d, dy = (u.y - v.y) / d;
        u.x += dx * push; u.y += dy * push; v.x -= dx * push; v.y -= dy * push;
        clamp(u); clamp(v);
      }
    }
    // 붕괴 지대: 안에 들어온 유닛을 가장자리로 밀어냄
    for (i = 0; i < state.zones.length; i++) {
      var z = state.zones[i];
      for (j = 0; j < a.length; j++) {
        var w = a[j], dd = Math.hypot(w.x - z.x, w.y - z.y), rr = z.r + w.arch.radius;
        if (dd < rr) { var nx = (w.x - z.x) / (dd || 1), ny = (w.y - z.y) / (dd || 1);
          w.x = z.x + nx * rr; w.y = z.y + ny * rr; clamp(w); }
      }
    }
  }

  function firstAliveOfType(list, type, exclude) {
    for (var i = 0; i < list.length; i++)
      if (list[i].alive && list[i] !== exclude && list[i].arch.key === type) return list[i];
    return null;
  }
  function findSurroundedAlly(allies, foes, exclude) {
    var cand = null, worst = 1;
    for (var i = 0; i < allies.length; i++) {
      var a = allies[i];
      if (!a.alive || a === exclude) continue;
      if (U.isSurrounded(a, foes, 60)) {
        var hp = a.hp / a.maxHp;
        if (hp < worst) { worst = hp; cand = a; }
      }
    }
    return cand;
  }

  function doAttack(u, tgt) {
    u.cd = u.arch.attackCd;
    // ★ 버퍼 오라: 같은 팀 버퍼가 근처에 살아있으면 공격력 상승
    //   → 버퍼를 살려두면 적이 실제로 강해진다 = "지원형 우선" 교리가 옳은 판단이 되는 이유
    var allies = u.team === 'player' ? state.player : state.enemy;
    var mul = (u.dmgMul || 1) * U.buffMul(u, allies);
    tgt._dmg = (tgt._dmg || 0) + u.arch.dmg * mul;               // 동시 해소
    tgt._lastHitBy = u;
    u.recoil = 0.12;                            // 공격 반동(스쿼시)
    if (u.arch.ranged) {                        // 원거리: 날아가는 투사체
      projectiles.push({ x: u.x, y: u.y, tx: tgt.x, ty: tgt.y, team: u.team,
        kind: u.arch.healer ? 'heal' : 'bolt', t: 0, dur: 0.16 });
    } else {                                    // 근접: 즉시 타격 스파크
      spawnParticles(tgt.x, tgt.y, u.team === 'player' ? '#9fd0ff' : '#ffb0b8', 4, 60);
    }
  }

  // 프레임 종료 시 데미지/힐 일괄 적용 (선(先) 힐 → 후(後) 데미지). 대칭 미러는 동시 전멸 → 무승부.
  function resolveDamage() {
    for (var i = 0; i < state.all.length; i++) {
      var u = state.all[i];
      if (!u.alive) continue;
      if (u._heal) { u.hp = Math.min(u.maxHp, u.hp + u._heal); u._heal = 0; }
      if (u._dmg) {
        u.hp -= u._dmg; u._dmg = 0;
        if (u.hp <= 0) {
          u.alive = false; u.deathT = 0;
          spawnParticles(u.x, u.y, u.team === 'player' ? '#46b1ff' : '#ff5468', 18, 130);
          shake = Math.min(9, shake + 5);
          state.newKills++;
          // ★ 교리 추론의 근거: 플레이어가 "어떤 역할군을" 먼저 제거했는가
          if (u.team === 'enemy') state.killedRoles.push(u.arch.role);
          // ★ 자폭(volatile) — 교리를 그대로 적용하면 오히려 손해인 예외 상황
          if (U.hasTrait(u, 'volatile')) detonate(u);
          var k = u._lastHitBy;
          var killer = !k ? '?' : (k.team === 'hazard' ? '☄ 폭격' : (k.team === 'player' ? '아군' : '적') + ' ' + k.arch.label);
          state.log.push('[' + state.t.toFixed(1) + 's] ' + killer + ' → ' +
            (u.team === 'player' ? '아군' : '적') + ' ' + u.arch.label + ' 처치');
        } else u.hitFlash = 0.12;   // 피격 플래시(치명타 아님)
      }
    }
  }

  /**
   * ★ 자폭 — 폭탄 힐러가 죽으면 주변에 광역 피해.
   * 여기서 중요한 건 폭발 그 자체가 아니라, **교리 때문에 이 폭발을 맞았는지**를
   * 기록한다는 점이다. 그 기록이 전투 후 AI가 "예외가 필요하다"고 판단하는 근거가 된다.
   */
  function detonate(u) {
    var A_ = u.arch, hit = 0;
    spawnParticles(u.x, u.y, '#ffb64a', 46, 240);
    shake = Math.min(16, shake + 12);
    for (var i = 0; i < state.all.length; i++) {
      var v = state.all[i];
      if (!v.alive || v === u) continue;
      if (U.dist(u, v) > A_.blastRange) continue;
      var falloff = 1 - U.dist(u, v) / A_.blastRange * 0.5;   // 가까울수록 큰 피해
      v._dmg = (v._dmg || 0) + A_.blastDmg * falloff;
      v._lastHitBy = { team: 'blast', arch: A_ };
      if (v.team === 'player') hit++;
    }
    state.log.push('[' + state.t.toFixed(1) + 's] ☣ ' + A_.label + ' 자폭! 아군 ' + hit + '명 피격');
    showToast('☣ ' + A_.label + '이(가) 자폭했습니다 — 아군 ' + hit + '명 피격', 'warn');
    // ★ 예외 학습의 근거: 교리가 발동해서 이 대상을 우선 타격한 결과라면 역효과로 기록
    var fd = state.firedDoctrine;
    if (hit > 0 && fd && fd.action.targetRole === u.arch.role && !fd.action.exceptTrait) {
      if (state.backfireTraits.indexOf('volatile') === -1) state.backfireTraits.push('volatile');
    }
  }

  function checkWin() {
    var pCan = U.canAttack(state.player).length, eCan = U.canAttack(state.enemy).length;
    if (pCan === 0 || eCan === 0 || state.t >= state.maxT) {
      state.over = true; running = false;
      if (pCan > 0 && eCan === 0) state.winner = 'player';
      else if (eCan > 0 && pCan === 0) state.winner = 'enemy';
      else {
        // 시간 종료 → 총 잔여 체력 비교
        var ph = sumHp(state.player), eh = sumHp(state.enemy);
        state.winner = ph > eh ? 'player' : (eh > ph ? 'enemy' : 'draw');
      }
      // 별 판정: 1★ 승리 · 2★ 3명 이상 생존 · 3★ 전원 생존
      var survivors = U.alive(state.player).length, total = state.player.length;
      state.survivors = survivors; state.totalUnits = total;
      state.stars = state.winner !== 'player' ? 0 : (survivors >= total ? 3 : survivors >= 3 ? 2 : 1);
      if (state.stars > 0) commitProgress(state.stage, state.stars);
      showResult();
    }
  }
  function sumHp(list) { var s = 0; for (var i = 0; i < list.length; i++) if (list[i].alive) s += list[i].hp; return s; }

  // ---- 렌더링 ---------------------------------------------------------------
  function draw() {
    ctx.clearRect(0, 0, W, H);
    background();
    ctx.save();
    if (shake > 0.2) ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    grid();
    if (state) drawHazardsGround();
    if (state && !state.preview && running) drawTargetLines();
    drawProjectiles();
    if (state) {
      for (var k = 0; k < state.all.length; k++) drawShadow(state.all[k]);
      for (var m = 0; m < state.all.length; m++) drawUnit(state.all[m]);
    }
    drawParticles();
    if (state) drawFog();
    if (state && state.preview) previewHint();
    ctx.restore();
  }

  // 지면 이벤트: 붕괴 지대 + 폭격 경고/폭발
  function drawHazardsGround() {
    var i, z, h;
    for (i = 0; i < state.zones.length; i++) {
      z = state.zones[i];
      ctx.fillStyle = 'rgba(20,10,26,0.72)';
      circle(z.x, z.y, z.r); ctx.fill();
      ctx.strokeStyle = 'rgba(170,120,255,0.5)'; ctx.lineWidth = 2;
      circle(z.x, z.y, z.r); ctx.stroke();
      // 균열선
      ctx.strokeStyle = 'rgba(170,120,255,0.35)'; ctx.lineWidth = 1;
      for (var a = 0; a < 5; a++) { var ang = a * 1.3 + z.t; ctx.beginPath(); ctx.moveTo(z.x, z.y); ctx.lineTo(z.x + Math.cos(ang) * z.r, z.y + Math.sin(ang) * z.r); ctx.stroke(); }
    }
    for (i = 0; i < state.hazards.length; i++) {
      h = state.hazards[i];
      if (h.phase === 'warn') {
        var prog = h.t / h.warnDur, pulse = 0.5 + 0.5 * Math.sin(state.t * 14);
        ctx.strokeStyle = 'rgba(255,90,70,' + (0.5 + pulse * 0.4) + ')'; ctx.lineWidth = 2; ctx.setLineDash([5, 5]);
        circle(h.x, h.y, h.r); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(255,90,70,0.1)'; circle(h.x, h.y, h.r * prog); ctx.fill();
        // 조준 십자
        ctx.strokeStyle = 'rgba(255,120,90,0.7)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(h.x - h.r * 0.5, h.y); ctx.lineTo(h.x + h.r * 0.5, h.y);
        ctx.moveTo(h.x, h.y - h.r * 0.5); ctx.lineTo(h.x, h.y + h.r * 0.5); ctx.stroke();
      } else if (h.phase === 'blast') {
        var e = h.t / h.blastDur;
        var g = ctx.createRadialGradient(h.x, h.y, 1, h.x, h.y, h.r);
        g.addColorStop(0, 'rgba(255,240,180,' + (0.9 * (1 - e)) + ')');
        g.addColorStop(0.6, 'rgba(255,150,50,' + (0.7 * (1 - e)) + ')');
        g.addColorStop(1, 'rgba(255,80,40,0)');
        ctx.fillStyle = g; circle(h.x, h.y, h.r * (0.8 + e * 0.4)); ctx.fill();
      }
    }
  }
  function drawFog() {
    if (!state.fog) return;
    var f = state.fog, a = Math.min(1, f.t / 0.8) * Math.min(1, (f.dur - f.t) / 0.8);
    ctx.save(); ctx.fillStyle = 'rgba(150,165,185,' + (0.16 * a) + ')'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(200,210,225,' + (0.06 * a) + ')'; ctx.lineWidth = 24;
    for (var y = ((state.t * 12) % 60) - 60; y < H; y += 60) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y + 20); ctx.stroke(); }
    ctx.restore();
  }

  // 타겟팅 라인 — 각 유닛이 지금 누구를 노리는지(=AI의 타겟 결정)를 시각화.
  // "화력 집중" 지시 시 선들이 한 적에게 수렴하는 게 눈에 보인다.
  function drawTargetLines() {
    ctx.setLineDash([2, 5]); ctx.lineWidth = 1;
    for (var i = 0; i < state.all.length; i++) {
      var u = state.all[i];
      if (!u.alive || u.arch.healer || !u.target || !u.target.alive) continue;
      ctx.strokeStyle = u.team === 'player' ? 'rgba(70,177,255,0.16)' : 'rgba(255,84,104,0.13)';
      ctx.beginPath(); ctx.moveTo(u.x, u.y); ctx.lineTo(u.target.x, u.target.y); ctx.stroke();
      // 타겟 지점 작은 마커
      ctx.fillStyle = u.team === 'player' ? 'rgba(70,177,255,0.5)' : 'rgba(255,84,104,0.45)';
      ctx.beginPath(); ctx.arc(u.target.x, u.target.y, 2, 0, 7); ctx.fill();
    }
    ctx.setLineDash([]);
  }

  function drawShadow(u) {
    if (!u.alive) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + u.arch.radius + 4, u.arch.radius * 0.9, u.arch.radius * 0.35, 0, 0, 7); ctx.fill();
    ctx.restore();
  }

  function previewHint() {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,182,74,0.9)'; ctx.font = '600 13px ui-monospace, monospace';
    ctx.fillText('부대 배치 완료', W / 2, H - 44);
    ctx.fillStyle = 'rgba(150,168,196,0.7)'; ctx.font = '12px system-ui';
    ctx.fillText('지시문을 입력하고 ▶ 전투 시작', W / 2, H - 26);
    ctx.restore();
  }

  function background() {
    var g = ctx.createRadialGradient(W / 2, H * 0.42, 40, W / 2, H / 2, Math.max(W, H) * 0.75);
    g.addColorStop(0, '#0c1626'); g.addColorStop(1, '#060a11');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  function grid() {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(120,170,255,0.045)';
    for (var x = (W / 2) % 42; x < W; x += 42) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = (H / 2) % 42; y < H; y += 42) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }
    // 중앙 분단선
    ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.setLineDash([6, 8]);
    ctx.beginPath(); ctx.moveTo(W / 2, 14); ctx.lineTo(W / 2, H - 14); ctx.stroke();
    ctx.setLineDash([]);
    // 진영 발판 표시
    ctx.fillStyle = 'rgba(70,177,255,0.05)'; ctx.fillRect(0, 0, W * 0.28, H);
    ctx.fillStyle = 'rgba(255,84,104,0.05)'; ctx.fillRect(W * 0.72, 0, W * 0.28, H);
  }

  function drawProjectiles() {
    for (var i = 0; i < projectiles.length; i++) {
      var p = projectiles[i], f = Math.min(1, p.t / p.dur);
      var x = p.x + (p.tx - p.x) * f, y = p.y + (p.ty - p.y) * f;
      if (p.kind === 'heal') {
        ctx.strokeStyle = 'rgba(62,224,138,' + (0.7 * (1 - f) + 0.2) + ')';
        ctx.lineWidth = 2.5; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(x, y); ctx.stroke();
      } else {
        var col = p.team === 'player' ? '210,235,255' : '255,200,205';
        var ang = Math.atan2(p.ty - p.y, p.tx - p.x);
        ctx.strokeStyle = 'rgba(' + col + ',0.95)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - Math.cos(ang) * 11, y - Math.sin(ang) * 11); ctx.stroke();
      }
    }
  }

  function drawParticles() {
    for (var i = 0; i < particles.length; i++) {
      var q = particles[i], a = 1 - q.life / q.max;
      ctx.globalAlpha = Math.max(0, a);
      ctx.fillStyle = q.col;
      ctx.beginPath(); ctx.arc(q.x, q.y, q.r * (0.4 + a * 0.6), 0, 7); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawUnit(u) {
    var r = u.arch.radius;
    // 사망: 잠깐 폭발 잔광 후 흐릿한 잔해
    if (!u.alive) {
      var dt2 = u.deathT || 0;
      if (dt2 < 0.5) {
        var e = dt2 / 0.5;
        ctx.strokeStyle = 'rgba(' + (u.team === 'player' ? '70,177,255' : '255,84,104') + ',' + (0.6 * (1 - e)) + ')';
        ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(u.x, u.y, r + e * 16, 0, 7); ctx.stroke();
      }
      ctx.globalAlpha = 0.14; ctx.fillStyle = '#39435a';
      ctx.beginPath(); ctx.arc(u.x, u.y, r * 0.8, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      return;
    }
    var ally = u.team === 'player';
    var base = ally ? '#46b1ff' : '#ff5468';
    var hpPct = Math.max(0, u.hp / u.maxHp);
    var sq = 1 + (u.recoil ? u.recoil * 1.4 : 0);   // 공격 반동 스쿼시

    // 외곽 글로우
    ctx.save();
    var glow = ctx.createRadialGradient(u.x, u.y, 1, u.x, u.y, r + 10);
    glow.addColorStop(0, (ally ? 'rgba(70,177,255,' : 'rgba(255,84,104,') + '0.45)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(u.x, u.y, r + 10, 0, 7); ctx.fill();
    ctx.restore();

    // 저체력 경고 링(펄스)
    if (hpPct < 0.35) {
      var pulse = 0.5 + 0.5 * Math.sin((state ? state.t : 0) * 10);
      ctx.strokeStyle = 'rgba(255,90,90,' + (0.35 + pulse * 0.4) + ')'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(u.x, u.y, r + 3 + pulse * 2, 0, 7); ctx.stroke();
    }
    // 후퇴 링
    if (u.retreating) {
      ctx.strokeStyle = 'rgba(255,182,74,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.arc(u.x, u.y, r + 5, 0, 7); ctx.stroke(); ctx.setLineDash([]);
    }

    // 병종별 캐릭터 스프라이트 (적은 좌우 반전해 서로 마주보게, 공격 반동 스쿼시)
    var face = ally ? 1 : -1;
    var vs = 1.28;   // 스프라이트 시각 배율(게임플레이 반경과 분리 → 밸런스 불변)
    ctx.save();
    ctx.translate(u.x, u.y + r * 0.12);
    ctx.scale(face * sq * vs, sq * vs);
    drawCharacter(u.arch.key, r, ally);
    ctx.restore();
    // 피격/치유 플래시 (캐릭터 위 틴트)
    if (u.hitFlash > 0) { ctx.fillStyle = 'rgba(255,255,255,' + (u.hitFlash / 0.12 * 0.5) + ')';
      ctx.beginPath(); ctx.arc(u.x, u.y - r * 0.2, r * 1.2, 0, 7); ctx.fill(); }
    if (u.healFlash > 0) { ctx.fillStyle = 'rgba(62,224,138,' + (u.healFlash / 0.25 * 0.5) + ')';
      ctx.beginPath(); ctx.arc(u.x, u.y - r * 0.2, r * 1.2, 0, 7); ctx.fill(); }

    // HP 바
    var w = 30, h = 4, bx = u.x - w / 2, by = u.y - r - 11;
    ctx.fillStyle = 'rgba(0,0,0,0.55)'; roundRect(bx - 1, by - 1, w + 2, h + 2, 2); ctx.fill();
    ctx.fillStyle = u.arch.healer ? '#3ee08a' : (hpPct < 0.35 ? '#ff6b6b' : (ally ? '#7dc4ff' : '#ff8a8a'));
    roundRect(bx, by, w * hpPct, h, 2); ctx.fill();
  }

  function roundRect(x, y, w, h, r) {
    w = Math.max(0, w);
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function circle(cx, cy, rr) { ctx.beginPath(); ctx.arc(cx, cy, rr, 0, 7); }
  function tri(ax, ay, bx, by, cx, cy) { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cx, cy); ctx.closePath(); }

  // ===== 병종별 캐릭터 (오른쪽을 향해 그림 · 로컬 원점 = 유닛 중심) ============
  var SKIN = '#e7c9a6', METAL = '#ccd6e4', METAL_D = '#8a97aa';
  function drawCharacter(key, r, ally) {
    var col = ally ? '#54abf5' : '#ff5f70';
    var dark = ally ? '#2c6699' : '#ab3a48';
    if (key === 'warrior') drawWarrior(r, col, dark);
    else if (key === 'archer') drawArcher(r, col, dark);
    else if (key === 'healer') drawHealer(r, col, dark);
    else if (key === 'buffer') drawBuffer(r, col, dark);
    else if (key === 'bomber') drawBomber(r, col, dark);
    else if (key === 'boss') drawBoss(r);
  }

  // 폭탄 힐러 — 힐러와 같은 지원형 실루엣(로브·후드·십자)에 폭탄을 얹었다.
  // 지원형으로 보여야 교리가 발동하고, 폭탄이 보여야 플레이어가 "어?" 한다.
  function drawBomber(r, col, dark) {
    var green = '#3ee08a', warn = '#ff9e28';
    // 로브
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(-0.42 * r, -0.12 * r); ctx.lineTo(0.42 * r, -0.12 * r);
    ctx.lineTo(0.72 * r, 1.2 * r); ctx.lineTo(-0.72 * r, 1.2 * r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath(); ctx.moveTo(-0.72 * r, 1.2 * r); ctx.lineTo(0.72 * r, 1.2 * r);
    ctx.lineTo(0.62 * r, 0.98 * r); ctx.lineTo(-0.62 * r, 0.98 * r); ctx.closePath(); ctx.fill();
    // 십자 (지원형이라는 단서 — 교리가 이걸 보고 발동한다)
    ctx.fillStyle = green; roundRect(-0.07 * r, 0.0 * r, 0.14 * r, 0.5 * r, 0.04 * r); ctx.fill();
    roundRect(-0.24 * r, 0.17 * r, 0.48 * r, 0.14 * r, 0.04 * r); ctx.fill();
    // 머리 + 후드
    ctx.fillStyle = SKIN; circle(0, -0.58 * r, 0.34 * r); ctx.fill();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, -0.62 * r, 0.42 * r, Math.PI * 0.82, Math.PI * 2.18); ctx.fill();
    // 등에 멘 폭탄 + 점멸하는 신관
    var pulse = 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 6);
    ctx.fillStyle = '#2a2f3a'; circle(0.02 * r, 0.72 * r, 0.34 * r); ctx.fill();
    ctx.strokeStyle = warn; ctx.lineWidth = 0.07 * r;
    ctx.beginPath(); ctx.arc(0.02 * r, 0.72 * r, 0.34 * r, 0, 7); ctx.stroke();
    ctx.fillStyle = 'rgba(255,158,40,' + (0.35 + 0.65 * pulse) + ')';
    circle(0.02 * r, 0.72 * r, 0.15 * r); ctx.fill();
    // 신관 심지
    ctx.strokeStyle = '#8a6b4a'; ctx.lineWidth = 0.06 * r; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.02 * r, 0.4 * r); ctx.quadraticCurveTo(0.3 * r, 0.28 * r, 0.34 * r, 0.1 * r); ctx.stroke();
    var sg = ctx.createRadialGradient(0.34 * r, 0.06 * r, 0.5, 0.34 * r, 0.06 * r, 0.3 * r);
    sg.addColorStop(0, 'rgba(255,214,120,' + (0.5 + 0.5 * pulse) + ')'); sg.addColorStop(1, 'rgba(255,158,40,0)');
    ctx.fillStyle = sg; circle(0.34 * r, 0.06 * r, 0.3 * r); ctx.fill();
    // 위험 경고 링
    ctx.strokeStyle = 'rgba(255,158,40,' + (0.2 + 0.3 * pulse) + ')'; ctx.lineWidth = 0.06 * r;
    ctx.beginPath(); ctx.ellipse(0, 1.16 * r, 0.9 * r, 0.3 * r, 0, 0, 7); ctx.stroke();
  }

  // 버퍼 — 힐러와 같은 '지원형' 실루엣(로브·후드)에 깃발을 든 모습.
  // 한눈에 "지원형"으로 읽혀야 교리 일반화의 순간이 성립한다.
  function drawBuffer(r, col, dark) {
    var amber = '#ffb64a';
    // 로브 (힐러와 같은 계열 실루엣 = 같은 역할군이라는 시각적 단서)
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(-0.42 * r, -0.12 * r); ctx.lineTo(0.42 * r, -0.12 * r);
    ctx.lineTo(0.72 * r, 1.2 * r); ctx.lineTo(-0.72 * r, 1.2 * r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath(); ctx.moveTo(-0.72 * r, 1.2 * r); ctx.lineTo(0.72 * r, 1.2 * r);
    ctx.lineTo(0.62 * r, 0.98 * r); ctx.lineTo(-0.62 * r, 0.98 * r); ctx.closePath(); ctx.fill();
    // 가슴의 산형(↑) 문양 — 강화
    ctx.strokeStyle = amber; ctx.lineWidth = 0.11 * r; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.moveTo(-0.24 * r, 0.5 * r); ctx.lineTo(0, 0.18 * r); ctx.lineTo(0.24 * r, 0.5 * r); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-0.24 * r, 0.82 * r); ctx.lineTo(0, 0.5 * r); ctx.lineTo(0.24 * r, 0.82 * r); ctx.stroke();
    // 머리 + 후드
    ctx.fillStyle = SKIN; circle(0, -0.58 * r, 0.34 * r); ctx.fill();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, -0.62 * r, 0.42 * r, Math.PI * 0.82, Math.PI * 2.18); ctx.fill();
    // 깃대 + 깃발(펄럭임)
    ctx.strokeStyle = '#8a6b4a'; ctx.lineWidth = 0.1 * r; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.64 * r, 1.15 * r); ctx.lineTo(0.64 * r, -1.35 * r); ctx.stroke();
    var w = Math.sin(performance.now() / 1000 * 3.2) * 0.09 * r;
    ctx.fillStyle = amber;
    ctx.beginPath(); ctx.moveTo(0.64 * r, -1.3 * r);
    ctx.quadraticCurveTo(1.25 * r + w, -1.16 * r, 1.5 * r, -0.86 * r);
    ctx.quadraticCurveTo(1.05 * r - w, -0.78 * r, 0.64 * r, -0.6 * r);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#caa14a'; circle(0.64 * r, -1.4 * r, 0.1 * r); ctx.fill();
    // 오라 링
    ctx.strokeStyle = 'rgba(255,182,74,0.5)'; ctx.lineWidth = 0.06 * r;
    ctx.beginPath(); ctx.ellipse(0, 1.16 * r, 0.85 * r, 0.28 * r, 0, 0, 7); ctx.stroke();
  }

  function drawWarrior(r, col, dark) {
    // 방패(뒤)
    ctx.fillStyle = METAL; ctx.beginPath(); ctx.ellipse(-0.78 * r, 0.15 * r, 0.42 * r, 0.68 * r, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = dark; ctx.lineWidth = 0.13 * r; ctx.stroke();
    ctx.fillStyle = col; circle(-0.78 * r, 0.15 * r, 0.15 * r); ctx.fill();
    // 다리
    ctx.fillStyle = dark; roundRect(-0.4 * r, 0.5 * r, 0.32 * r, 0.72 * r, 0.1 * r); ctx.fill();
    roundRect(0.08 * r, 0.5 * r, 0.32 * r, 0.72 * r, 0.1 * r); ctx.fill();
    // 몸통(갑옷) + 가슴판 + 견장
    ctx.fillStyle = col; roundRect(-0.5 * r, -0.28 * r, 1.0 * r, 1.0 * r, 0.28 * r); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)'; roundRect(-0.3 * r, -0.14 * r, 0.6 * r, 0.56 * r, 0.16 * r); ctx.fill();
    ctx.fillStyle = dark; circle(-0.5 * r, -0.12 * r, 0.26 * r); ctx.fill(); circle(0.5 * r, -0.12 * r, 0.26 * r); ctx.fill();
    // 머리 + 투구
    ctx.fillStyle = SKIN; circle(0.04 * r, -0.72 * r, 0.4 * r); ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.arc(0.04 * r, -0.74 * r, 0.44 * r, Math.PI, 0); ctx.lineTo(0.48 * r, -0.6 * r); ctx.lineTo(-0.4 * r, -0.6 * r); ctx.closePath(); ctx.fill();
    roundRect(-0.02 * r, -0.82 * r, 0.12 * r, 0.4 * r, 0.04 * r); ctx.fill(); // 코가리개
    // 검(앞)
    ctx.save(); ctx.translate(0.64 * r, 0.12 * r); ctx.rotate(-0.32);
    ctx.fillStyle = METAL; roundRect(-0.085 * r, -1.5 * r, 0.17 * r, 1.45 * r, 0.05 * r); ctx.fill();
    ctx.fillStyle = METAL_D; roundRect(-0.02 * r, -1.5 * r, 0.04 * r, 1.45 * r, 0.02 * r); ctx.fill();
    ctx.fillStyle = '#caa14a'; roundRect(-0.28 * r, -0.1 * r, 0.56 * r, 0.14 * r, 0.05 * r); ctx.fill();
    ctx.fillStyle = dark; roundRect(-0.07 * r, 0.02 * r, 0.14 * r, 0.32 * r, 0.05 * r); ctx.fill();
    ctx.fillStyle = '#caa14a'; circle(0, 0.38 * r, 0.1 * r); ctx.fill();
    ctx.restore();
  }

  function drawArcher(r, col, dark) {
    // 다리
    ctx.fillStyle = dark; roundRect(-0.3 * r, 0.46 * r, 0.24 * r, 0.72 * r, 0.08 * r); ctx.fill();
    roundRect(0.06 * r, 0.46 * r, 0.24 * r, 0.72 * r, 0.08 * r); ctx.fill();
    // 몸통(슬림) + 벨트
    ctx.fillStyle = col; roundRect(-0.36 * r, -0.22 * r, 0.72 * r, 0.82 * r, 0.22 * r); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.28)'; roundRect(-0.36 * r, 0.12 * r, 0.72 * r, 0.12 * r, 0.04 * r); ctx.fill();
    // 머리 + 후드
    ctx.fillStyle = SKIN; circle(0.02 * r, -0.6 * r, 0.36 * r); ctx.fill();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0.0, -0.64 * r, 0.42 * r, Math.PI * 1.03, Math.PI * 2.07); ctx.fill();
    // 총(앞으로 겨눔)
    ctx.save(); ctx.translate(0.05 * r, 0.02 * r); ctx.rotate(-0.06);
    ctx.fillStyle = '#39414f'; roundRect(-0.5 * r, -0.04 * r, 0.5 * r, 0.26 * r, 0.06 * r); ctx.fill(); // 개머리판
    ctx.fillStyle = '#20252e'; roundRect(-0.05 * r, -0.02 * r, 1.5 * r, 0.16 * r, 0.05 * r); ctx.fill(); // 총열
    ctx.fillStyle = METAL_D; roundRect(1.36 * r, -0.05 * r, 0.12 * r, 0.22 * r, 0.03 * r); ctx.fill(); // 총구
    ctx.fillStyle = '#4a5566'; roundRect(0.22 * r, -0.17 * r, 0.3 * r, 0.11 * r, 0.03 * r); ctx.fill(); // 조준경
    ctx.strokeStyle = SKIN; ctx.lineWidth = 0.19 * r; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-0.05 * r, 0.12 * r); ctx.lineTo(0.5 * r, 0.06 * r); ctx.stroke(); // 팔
    ctx.restore();
  }

  function drawHealer(r, col, dark) {
    var green = '#3ee08a';
    // 로브
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.moveTo(-0.42 * r, -0.12 * r); ctx.lineTo(0.42 * r, -0.12 * r);
    ctx.lineTo(0.72 * r, 1.2 * r); ctx.lineTo(-0.72 * r, 1.2 * r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.beginPath(); ctx.moveTo(-0.72 * r, 1.2 * r); ctx.lineTo(0.72 * r, 1.2 * r); ctx.lineTo(0.62 * r, 0.98 * r); ctx.lineTo(-0.62 * r, 0.98 * r); ctx.closePath(); ctx.fill();
    // 초록 십자 문양
    ctx.fillStyle = green; roundRect(-0.08 * r, -0.05 * r, 0.16 * r, 0.95 * r, 0.04 * r); ctx.fill();
    roundRect(-0.3 * r, 0.3 * r, 0.6 * r, 0.16 * r, 0.04 * r); ctx.fill();
    // 머리 + 후드
    ctx.fillStyle = SKIN; circle(0, -0.58 * r, 0.34 * r); ctx.fill();
    ctx.fillStyle = dark; ctx.beginPath(); ctx.arc(0, -0.62 * r, 0.42 * r, Math.PI * 0.82, Math.PI * 2.18); ctx.fill();
    // 지팡이 + 발광 오브 + 십자
    ctx.strokeStyle = '#8a6b4a'; ctx.lineWidth = 0.11 * r; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0.62 * r, 1.15 * r); ctx.lineTo(0.62 * r, -1.1 * r); ctx.stroke();
    var og = ctx.createRadialGradient(0.62 * r, -1.18 * r, 0.5, 0.62 * r, -1.18 * r, 0.62 * r);
    og.addColorStop(0, 'rgba(62,224,138,0.85)'); og.addColorStop(1, 'rgba(62,224,138,0)');
    ctx.fillStyle = og; circle(0.62 * r, -1.18 * r, 0.62 * r); ctx.fill();
    ctx.fillStyle = green; circle(0.62 * r, -1.18 * r, 0.23 * r); ctx.fill();
    ctx.strokeStyle = '#eafff2'; ctx.lineWidth = 0.08 * r; ctx.lineCap = 'butt';
    ctx.beginPath(); ctx.moveTo(0.62 * r, -1.32 * r); ctx.lineTo(0.62 * r, -1.04 * r);
    ctx.moveTo(0.48 * r, -1.18 * r); ctx.lineTo(0.76 * r, -1.18 * r); ctx.stroke();
  }

  function drawBoss(r) {
    var bd = '#c73a4a', bdk = '#7d2531';
    // 다리
    ctx.fillStyle = bdk; roundRect(-0.45 * r, 0.55 * r, 0.35 * r, 0.7 * r, 0.1 * r); ctx.fill();
    roundRect(0.1 * r, 0.55 * r, 0.35 * r, 0.7 * r, 0.1 * r); ctx.fill();
    // 몸통 + 명암
    ctx.fillStyle = bd; roundRect(-0.62 * r, -0.3 * r, 1.24 * r, 1.05 * r, 0.26 * r); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; roundRect(-0.28 * r, -0.16 * r, 0.56 * r, 0.7 * r, 0.14 * r); ctx.fill();
    // 스파이크 견장
    ctx.fillStyle = bdk;
    [-0.62, 0.62].forEach(function (sx) {
      circle(sx * r, -0.14 * r, 0.3 * r); ctx.fill();
      tri(sx * r - 0.2 * r, -0.28 * r, sx * r, -0.78 * r, sx * r + 0.2 * r, -0.28 * r); ctx.fill();
    });
    // 머리 + 뿔 + 발광 눈
    ctx.fillStyle = bdk; circle(0, -0.72 * r, 0.44 * r); ctx.fill();
    ctx.fillStyle = '#e9ddd1';
    tri(-0.4 * r, -0.9 * r, -0.66 * r, -1.5 * r, -0.18 * r, -1.04 * r); ctx.fill();
    tri(0.4 * r, -0.9 * r, 0.66 * r, -1.5 * r, 0.18 * r, -1.04 * r); ctx.fill();
    ctx.fillStyle = '#ffd23e'; ctx.shadowColor = '#ffb020'; ctx.shadowBlur = 6;
    circle(-0.16 * r, -0.72 * r, 0.08 * r); ctx.fill(); circle(0.16 * r, -0.72 * r, 0.08 * r); ctx.fill();
    ctx.shadowBlur = 0;
    // 대검(앞)
    ctx.save(); ctx.translate(0.72 * r, 0.18 * r); ctx.rotate(-0.38);
    ctx.fillStyle = METAL;
    ctx.beginPath(); ctx.moveTo(-0.16 * r, 0); ctx.lineTo(0.16 * r, 0); ctx.lineTo(0.1 * r, -1.65 * r); ctx.lineTo(0, -1.9 * r); ctx.lineTo(-0.1 * r, -1.65 * r); ctx.closePath(); ctx.fill();
    ctx.fillStyle = bdk; roundRect(-0.34 * r, 0, 0.68 * r, 0.16 * r, 0.05 * r); ctx.fill();
    ctx.fillStyle = '#4a2a2f'; roundRect(-0.08 * r, 0.14 * r, 0.16 * r, 0.42 * r, 0.05 * r); ctx.fill();
    ctx.restore();
  }

  // ---- 시각 효과 업데이트 (실시간 dt, 시뮬 배속과 무관) -----------------------
  function updateVisuals(rdt) {
    if (shake > 0) shake = Math.max(0, shake - rdt * 24);
    var i;
    for (i = projectiles.length - 1; i >= 0; i--) { projectiles[i].t += rdt; if (projectiles[i].t >= projectiles[i].dur) projectiles.splice(i, 1); }
    for (i = particles.length - 1; i >= 0; i--) {
      var q = particles[i]; q.life += rdt; q.x += q.vx * rdt; q.y += q.vy * rdt;
      q.vx *= (1 - rdt * 3); q.vy *= (1 - rdt * 3);
      if (q.life >= q.max) particles.splice(i, 1);
    }
    if (state) for (i = 0; i < state.all.length; i++) {
      var u = state.all[i];
      if (u.recoil > 0) u.recoil = Math.max(0, u.recoil - rdt);
      if (u.hitFlash > 0) u.hitFlash = Math.max(0, u.hitFlash - rdt);
      if (u.healFlash > 0) u.healFlash = Math.max(0, u.healFlash - rdt);
      if (!u.alive && u.deathT != null) u.deathT += rdt;
    }
  }

  // ---- 루프 (실제 경과시간 기반 고정 타임스텝: 프레임레이트 독립) -----------
  var acc = 0;
  function loop(ts) {
    if (!lastTs) lastTs = ts;
    var real = (ts - lastTs) / 1000;
    lastTs = ts;
    if (real > 1.0) real = 1.0; // 탭 복귀/랙 시 한 번에 최대 1초분만 따라잡음(폭주 방지)
    if (running && state && !state.over) {
      acc += real * speed;
      var fixed = 1 / 60, guard = 0;
      while (acc >= fixed && guard < 900) { step(fixed); acc -= fixed; guard++; }
    }
    updateVisuals(real);
    draw();
    updateHUD();
    requestAnimationFrame(loop);
  }

  // ---- 헤드리스 시뮬레이터 (밸런스/로직 검증 · 자동화 테스트용) --------------
  // 렌더링 없이 전투를 끝까지 즉시 계산해 결과를 반환. UI와 동일한 step() 사용.
  window.Commander = {
    simulate: function (text, stageIdx, cap) {
      newBattle(text || '', stageIdx != null ? stageIdx : 0);
      var dt = 1 / 60, n = 0; cap = cap || 9000;
      while (state && !state.over && n < cap) { step(dt); n++; }
      if (state.stars == null) { var sv = U.alive(state.player).length; state.survivors = sv;
        state.stars = state.winner !== 'player' ? 0 : (sv >= state.player.length ? 3 : sv >= 3 ? 2 : 1); }
      return report(text);
    },
    // 전투 중 규칙을 순차 추가하며 시뮬(라이브 독트린 검증). adds=[{t,text}]
    simulateLive: function (text, stageIdx, adds) {
      newBattle(text || '', stageIdx != null ? stageIdx : 0);
      adds = (adds || []).slice().sort(function (a, b) { return a.t - b.t; });
      var dt = 1 / 60, n = 0, ai = 0;
      while (state && !state.over && n < 9000) {
        step(dt); n++;
        while (ai < adds.length && state.t >= adds[ai].t) { pushRule(adds[ai].text); ai++; }
      }
      if (state.stars == null) { var sv = U.alive(state.player).length; state.survivors = sv;
        state.stars = state.winner !== 'player' ? 0 : (sv >= state.player.length ? 3 : sv >= 3 ? 2 : 1); }
      return report(text);
    },
    mirror: function (text) {
      newBattle(text || '', 0);
      enemyPolicy = state.effPolicy; state.enemy.forEach(function (u) { u.policy = state.effPolicy; });
      var dt = 1 / 60, n = 0;
      while (state && !state.over && n < 6000) { step(dt); n++; }
      return report(text);
    },
    stages: function () { return STAGES.map(function (s) { return s.id + ':' + s.name; }); },
    resetProgress: function () { progress = {}; try { localStorage.removeItem('commander_progress'); } catch (e) {} return 'ok'; }
  };
  // 밸런스 스윕용: 적 기준선 정책을 런타임에 덮어쓴다(테스트 전용).
  window.Commander.setEnemy = function (partial) { enemyOverride = partial; };
  window.Commander.clearEnemy = function () { enemyOverride = null; };
  window.Commander._stages = STAGES;   // (테스트) 스테이지 배율 스윕용
  // (테스트) 교리 메모리를 런타임에 교체 — 교리 유무/예외 유무의 A/B 검증용
  window.Commander._setDoctrines = function (list) { doctrines = list || []; renderDoctrineMem(); };
  window.Commander._getDoctrines = function () { return doctrines; };
  // 시연 중 침묵 길이 즉석 조정 — 친구들에게 보여주며 값을 정한다.
  window.Commander.silence = function (ms) { if (ms != null) SILENCE_MS = ms; return SILENCE_MS; };

  // ★ 예측(forecast): 후보 지시문으로 헤드리스 N회 시뮬 → 승률/전멸률.
  //   현재 전투 상태를 저장·복원하므로 라이브 화면을 망치지 않는다. (AI 사령관의 근거)
  window.Commander.forecast = function (directive, stageIdx, n) {
    n = n || 14;
    var saved = state, savedEnemy = enemyPolicy, savedRun = running, savedStage = currentStage, savedOver = enemyOverride;
    running = false;
    var wins = 0, wipes = 0, surv = 0, tsum = 0;
    for (var i = 0; i < n; i++) {
      var r = window.Commander.simulate(directive, stageIdx != null ? stageIdx : savedStage);
      if (r.winner === 'player') wins++;
      if (r.survivors === 0) wipes++;
      surv += r.survivors; tsum += r.t;
    }
    state = saved; enemyPolicy = savedEnemy; running = savedRun; currentStage = savedStage; enemyOverride = savedOver;
    projectiles.length = 0; particles.length = 0; shake = 0;
    return { win: Math.round(wins / n * 100), wipe: Math.round(wipes / n * 100), surv: +(surv / n).toFixed(1), n: n };
  };
  window.Commander.pushRule = function (text) { return pushRule(text); };
  window.Commander.state = function () { return state; };
  function report(text) {
      var snap = function (list) { return list.map(function (u) { return u.arch.key + (u.alive ? ':' + Math.round(u.hp) : ':DEAD'); }); };
      return {
        directive: text, stage: STAGES[state.stage].name,
        winner: state.winner, t: +state.t.toFixed(1),
        stars: state.stars, survivors: state.survivors,
        killedRoles: state.killedRoles.slice(),   // 교리 분석의 근거(제거 순서)
        targetRole: state.effPolicy.targetRole,   // 이번 전투에 적용된 교리
        targetExcept: state.effPolicy.targetExcept,
        firedDoctrine: state.firedDoctrine ? state.firedDoctrine.name : null,
        backfireTraits: state.backfireTraits.slice(),
        playerLeft: U.canAttack(state.player).length,
        enemyLeft: U.canAttack(state.enemy).length,
        events: state.eventLog.slice(), adapts: state.adaptCount,
        player: snap(state.player), enemy: snap(state.enemy),
        log: state.log.slice(), rules: state.effPolicy._rules
      };
  }

  // ---- HUD 갱신 --------------------------------------------------------------
  var hudSig = '', feedSig = -1, eventSig = -1;
  function updateHUD() {
    var tEl = $('timer');
    if (tEl) tEl.textContent = (!state || state.preview) ? 'READY'
      : (state.over ? '종료 · ' + state.t.toFixed(1) + 's'
        : state.t.toFixed(1) + 's / ' + state.maxT + 's');

    var sig = state ? state.all.map(function (u) { return u.alive ? '1' : '0'; }).join('') : 'ready';
    if (sig !== hudSig) {
      hudSig = sig;
      renderPips('allyPips', state ? state.player : PLAYER_COMP.map(mk), 'allyAlive', 'allyTotal');
      renderPips('enemyPips', state ? state.enemy : PLAYER_COMP.map(mk), 'enemyAlive', 'enemyTotal');
    }
    var fl = state ? state.log.length : 0;
    if (fl !== feedSig) { feedSig = fl; renderFeed(); }
    var el2 = state ? state.eventLog.length : 0;
    if ( el2 !== eventSig) { eventSig = el2; renderEvents(); }
  }

  // 규칙 스택 + 병종별 해석 렌더
  function renderDoctrine() {
    if (!state) return;
    var el = $('doctrine');
    if (el) {
      // ★ 이번 전투에 실제로 발동한 교리를 보여준다. 교리가 여러 개면 AI가 하나를 '선택'하므로,
      //   무엇이 왜 발동했는지 보이지 않으면 플레이어도 심사위원도 인과를 추적할 수 없다.
      var fd = state.firedDoctrine;
      var act = fd
        ? '<div class="active-doc"><span class="ad-tag">적용 중인 교리</span>' +
            '<span class="ad-name">' + escapeHtml(fd.name) + '</span>' +
            (fd.condition && fd.condition.requiresTrait
              ? '<span class="ad-why">조건 성립: 이 전장에 ' +
                escapeHtml(window.Doctrine.TRAIT_LABEL[fd.condition.requiresTrait] || '') + ' 특성의 적이 있음</span>'
              : '') +
          '</div>'
        : '';
      if (!state.stack.length)
        el.innerHTML = act || '<div class="empty">명령도, 발동한 교리도 없습니다. AI는 기본 교전(가장 가까운 적)을 수행합니다.</div>';
      else {
        var h = '';
        for (var i = 0; i < state.stack.length; i++) {
          var f = state.stack[i];
          h += '<div class="rule"><span class="rn">' + (i + 1) + '</span><div class="rbody">' +
            '<div class="rtext">' + escapeHtml(f.text || '(규칙)') + '</div><div class="rchips">' +
            f.rules.map(function (r) { return '<span class="mchip">' + escapeHtml(r) + '</span>'; }).join('') +
            '</div></div></div>';
        }
        el.innerHTML = h; el.scrollTop = el.scrollHeight;
      }
    }
    var ci = $('classInterp');
    if (ci) {
      var m = classInterp(state.effPolicy);
      ci.innerHTML =
        '<div class="ci"><b class="w">⚔ 전사</b><span>' + escapeHtml(m.warrior) + '</span></div>' +
        '<div class="ci"><b class="a">🔫 원딜</b><span>' + escapeHtml(m.archer) + '</span></div>' +
        '<div class="ci"><b class="h">✚ 힐러</b><span>' + escapeHtml(m.healer) + '</span></div>';
    }
  }
  // 같은 정책도 병종마다 다르게 해석 (UI 노출 + 실제 행동은 step에서 분기)
  function classInterp(p) {
    var aggr = p.aggression > 0.7 ? '저돌적으로' : p.aggression < 0.35 ? '신중하게' : '표준 간격으로';
    var tgt = p.targetPriority === 'healer' ? '적 힐러를' : p.targetPriority === 'strongest' ? '가장 강한 적(보스)을'
      : p.targetPriority === 'archer' ? '적 원거리를' : p.targetPriority === 'weakest' ? '약한 적을' : '가까운 적을';
    return {
      warrior: tgt + ' 향해 ' + aggr + ' 돌진, 최전선 근접 교전' + (p.avoidHazards ? ' (위험지대 우회)' : '') + '.',
      archer: (p.kite ? '거리를 유지하며 ' : '') + tgt + ' 사격, ' + (p.aggression > 0.7 ? '과감히 전진' : '라인 유지') + (p.avoidHazards ? ' (폭격 밖에서 딜)' : '') + '.',
      healer: '전열 뒤에서 최저 체력 아군 우선 치유' + (p.protect ? ', 지정 아군 곁 사수' : '') + (p.regroup ? ', 아군 규합' : '') + (p.avoidHazards ? ', 위험지대 즉시 이탈' : '') + '.'
    };
  }

  function renderEvents() {
    var el = $('eventFeed'); if (!el) return;
    if (!state || !state.eventLog.length) { el.innerHTML = '<span class="empty">전장 이벤트가 여기에 표시됩니다.</span>'; return; }
    var last = state.eventLog.slice(-6), h = '';
    for (var i = 0; i < last.length; i++)
      h += '<div class="ev ' + last[i].kind + '"><span class="t">' + last[i].t.toFixed(0) + 's</span> ' + escapeHtml(last[i].text) + '</div>';
    el.innerHTML = h; el.scrollTop = el.scrollHeight;
  }

  function showToast(text, kind) {
    var el = $('toast'); if (!el) return;
    el.textContent = text; el.className = 'toast show ' + (kind || '');
    clearTimeout(showToast._t); showToast._t = setTimeout(function () { el.className = 'toast'; }, 2600);
  }
  function mk(key) { return { arch: A[key], alive: true }; }
  function renderPips(elId, list, countId, totalId) {
    var el = $(elId); if (!el) return;
    var alive = 0, html = '';
    for (var i = 0; i < list.length; i++) {
      var u = list[i]; if (u.alive) alive++;
      html += '<span class="pip' + (u.alive ? '' : ' dead') + (u.arch.boss ? ' boss' : '') + '">' + u.arch.glyph + '</span>';
    }
    el.innerHTML = html;
    var c = $(countId); if (c) c.textContent = alive;
    var t = $(totalId); if (t) t.textContent = list.length;
  }
  function renderFeed() {
    var el = $('feed'); if (!el) return;
    if (!state || !state.log.length) { el.innerHTML = '<span class="empty">교전 기록이 여기에 표시됩니다.</span>'; return; }
    var last = state.log.slice(-11), h = '';
    for (var i = 0; i < last.length; i++) {
      var m = last[i].match(/^\[([\d.]+)s\]\s(.+?)\s→\s(아군|적)\s(.+?)\s처치$/);
      if (m) {
        var cls = m[2].indexOf('아군') === 0 ? 'ally' : m[2].indexOf('폭격') >= 0 ? 'bomb' : 'enemy';
        h += '<div class="kill ' + cls + '"><span class="t">' + m[1] + 's</span> ' +
          escapeHtml(m[2]) + ' ▸ ' + m[3] + ' ' + escapeHtml(m[4]) + ' 처치</div>';
      } else h += '<div>' + escapeHtml(last[i]) + '</div>';
    }
    el.innerHTML = h; el.scrollTop = el.scrollHeight;
  }

  // ---- UI 연결 --------------------------------------------------------------
  var $ = function (id) { return document.getElementById(id); };

  function renderChips(policy, elId, title) {
    var el = $(elId);
    var html = '<div class="chips-title">' + title + '</div>';
    for (var i = 0; i < policy._rules.length; i++)
      html += '<span class="chip">' + escapeHtml(policy._rules[i]) + '</span>';
    el.innerHTML = html;
  }
  function escapeHtml(s) { return String(s).replace(/[&<>]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]; }); }

  function setStageBadge() {
    var s = STAGES[currentStage];
    var b = $('stageBadge');
    if (b) b.textContent = 'STAGE ' + s.id + ' · ' + s.name + (s.boss ? ' ☠' : '');
  }

  /**
   * ★ 전투 시작 — 자연어 명령을 먼저 '해석'한 뒤 전투를 연다.
   * 해석은 LLM(/api/intent)이 하고, 프록시가 없으면 정규식으로 자동 강등된다.
   * 그래서 이 함수는 비동기다: 사람의 말을 이해하는 데 시간이 걸리기 때문이다.
   */
  function runBattle(text) {
    var btn = $('start');
    if (text) { btn.disabled = true; btn.textContent = '⋯ 명령 해석 중'; }
    var enemies = STAGES[currentStage].comp.map(function (k) { return A[k].label; });
    return window.Doctrine.interpret(text, { enemies: enemies }).then(function (intent) {
      btn.disabled = false;
      resizeCanvas();
      newBattle(text, currentStage, intent);
      setStageBadge();
      renderDoctrine();
      renderChips(enemyPolicy, 'enemyRead', '적 부대 · ' + STAGES[currentStage].name);
      hideResult(); hudSig = ''; feedSig = -1; eventSig = -1;
      lastTs = 0; acc = 0;
      setCmdMode(true); $('directive').value = '';
      // 해석 결과를 플레이어에게 알린다 (이해했든 못 했든 정직하게)
      if (text) {
        running = true; bumpOrders();   // 종료 화면 통계: 당신이 내린 명령 수
        if (intent.understood) showToast('명령 해석: ' + (intent.rules[0] || intent.why || '적용됨'), 'add');
        else showToast('이 명령에서 전술을 읽지 못했습니다 — 기본 교전으로 진행합니다', 'warn');
      } else if (state.firedDoctrine) {
        // ★ 침묵의 순간 — 이 게임에서 가장 강한 2초.
        //   플레이어는 아무것도 입력하지 않았다. 전투를 잠깐 멈추고 그 '침묵'을 보여준다.
        //   심사위원이 "어? 왜 안 치지?" 하는 순간, AI가 스스로 움직인다.
        running = false;
        silenceThenApply(state.firedDoctrine);
      } else {
        running = true;   // 명령도 교리도 없음 — 기본 교전
      }
    });
  }

  // 침묵의 길이(ms). 감각은 숫자로 못 맞춘다 — 친구들에게 1.3/1.5/1.8초를 보여주고
  // "언제 가장 자연스러웠어?"로 정한다. 시연 중 콘솔에서 즉석 조정:
  //   Commander.silence(1300)  또는  Commander.silence(1500)
  var SILENCE_MS = 1800;

  /** 침묵 → 교리 발동. 무명령 전투에서 사령관의 자율성을 드러내는 연출. */
  function silenceThenApply(d) {
    var el = $('doctrineBeat'); if (!el) { running = true; return; }
    // 1단계: 침묵 (플레이어가 아무 말도 하지 않았음)
    el.innerHTML =
      '<div class="db-silence">당신은 침묵했습니다.</div>' +
      '<div class="db-silence-sub">사령관이 판단합니다…</div>';
    el.className = 'doctrine-beat show silence';
    draw();   // 배치된 부대를 정지 화면으로 보여준다
    clearTimeout(silenceThenApply._t1); clearTimeout(silenceThenApply._t2);
    // 2단계: SILENCE_MS 후 교리 발동 + 전투 시작
    silenceThenApply._t1 = setTimeout(function () {
      showDoctrineBeat(d);
      running = true; lastTs = 0; acc = 0;
    }, SILENCE_MS);
  }

  /** 교리 발동 배너 — 플레이어가 아무 말도 하지 않았는데 AI가 판단했음을 알린다 */
  function showDoctrineBeat(d) {
    var el = $('doctrineBeat'); if (!el) return;
    var cond = d.condition && d.condition.requiresTrait
      ? '이 전장에 ' + (window.Doctrine.TRAIT_LABEL[d.condition.requiresTrait] || '') + ' 특성의 적이 있습니다'
      : '';
    el.innerHTML =
      '<div class="db-tag">DOCTRINE APPLIED · 명령 없음</div>' +
      '<div class="db-name">' + escapeHtml(d.name) + '</div>' +
      (cond ? '<div class="db-cond">조건 성립 — ' + escapeHtml(cond) + '</div>' : '') +
      '<div class="db-rule">' + escapeHtml(d.rule) + '</div>';
    el.className = 'doctrine-beat show';
    clearTimeout(showDoctrineBeat._t);
    showDoctrineBeat._t = setTimeout(function () { el.className = 'doctrine-beat'; }, 4200);
  }
  // 전투 중 규칙 추가 — 여기서도 자연어를 정규식으로 문전박대하지 않는다
  function addRule() {
    var text = $('directive').value.trim();
    if (!text || !state || state.over) return;
    var btn = $('start');
    btn.disabled = true; btn.textContent = '⋯ 해석 중';
    var enemies = state.enemy.map(function (u) { return u.arch.label; });
    window.Doctrine.interpret(text, { enemies: enemies }).then(function (intent) {
      btn.disabled = false; setCmdMode(true);
      if (!intent.understood) { showToast('이 명령에서 전술을 읽지 못했습니다', 'warn'); return; }
      pushIntent(text, intent);
      renderDoctrine();
      showToast('규칙 추가: ' + (intent.rules[0] || text), 'add');
      bumpOrders();   // 전투 중 추가 명령도 '당신의 명령'에 포함
      $('directive').value = '';
    });
  }
  function resetBattle() {
    running = false; hideResult();
    deployPreview();
  }

  // 전투 전 부대를 대형으로 배치해 보여준다(빈 아레나 방지).
  function deployPreview() {
    newBattle($('directive') ? $('directive').value : '', currentStage);
    state.preview = true; running = false;
    setStageBadge(); hideResult(); hudSig = ''; feedSig = -1; eventSig = -1;
    renderDoctrine(); setCmdMode(false);
  }

  // ===== 작전 회의 (War Council) — 명령을 실행 전 AI 사령관과 심의 ============
  var councilPending = null;
  function boardSummary() {
    if (!state) return {};
    var f = function (list) { return list.map(function (u) { return u.arch.key; }); };
    return { stage: STAGES[currentStage].name, player: f(state.player), enemy: f(state.enemy) };
  }
  function openCouncil() {
    if (!state) deployPreview();
    var text = $('directive').value.trim();
    $('council').className = 'council';
    $('wcBackend').textContent = '전술 분석 · ' + (window.Advisor ? window.Advisor.backend().toUpperCase() : 'LOCAL');
    $('wcYou').textContent = text ? '“' + text + '”' : '(명령 없음 — 판단을 맡깁니다)';
    $('wcSay').textContent = 'AI 사령관이 전장을 분석하는 중…';
    $('wcForecast').className = 'wc-forecast hidden';
    $('wcActions').innerHTML = '';
    councilPending = { text: text };
    window.Advisor.advise({ command: text, stack: [], stage: currentStage, board: boardSummary() })
      .then(renderCouncil)
      .catch(function () { closeCouncil(); runBattle(text); });
  }
  function fbar(f, label) {
    if (!f) return '';
    return '<div class="fc-row"><span class="fc-label">' + escapeHtml(label) + '</span>' +
      '<div class="fc-bar"><i style="width:' + f.win + '%"></i></div>' +
      '<span class="fc-num">승 ' + f.win + '% · 전멸 ' + f.wipe + '%</span></div>';
  }
  function renderCouncil(adv) {
    if (!councilPending) return;
    councilPending.advice = adv;
    $('wcSay').textContent = adv.message;
    var fc = $('wcForecast');
    if (adv.forecastPlan) {
      fc.className = 'wc-forecast';
      fc.innerHTML = fbar(adv.forecastPlan, '이 명령') + (adv.forecastAlt && adv.alt ? fbar(adv.forecastAlt, '대안 · ' + adv.alt.label) : '');
    } else fc.className = 'wc-forecast hidden';
    var a = $('wcActions'), h = '';
    if (adv.stance === 'question' && adv.options) {
      for (var i = 0; i < adv.options.length; i++) h += '<button class="wc-btn opt" data-opt="' + i + '">' + escapeHtml(adv.options[i].label) + '</button>';
      h += '<button class="wc-btn ghost" data-act="edit">✎ 직접 입력</button>';
    } else if (adv.stance === 'warn') {
      h += '<button class="wc-btn danger" data-act="force">⚔ 그래도 강행</button>';
      if (adv.options && adv.options[0]) h += '<button class="wc-btn primary" data-act="alt">↪ ' + escapeHtml(adv.options[0].label) + '</button>';
      h += '<button class="wc-btn ghost" data-act="edit">✎ 수정</button>';
    } else {
      h += '<button class="wc-btn primary" data-act="exec">▶ 작전 실행</button>';
      h += '<button class="wc-btn ghost" data-act="edit">✎ 수정</button>';
    }
    a.innerHTML = h;
    Array.prototype.forEach.call(a.querySelectorAll('button'), function (b) {
      b.addEventListener('click', function () { councilAction(b.getAttribute('data-act'), b.getAttribute('data-opt')); });
    });
  }
  function councilAction(act, optIdx) {
    var adv = councilPending.advice, text = councilPending.text;
    if (act === 'edit') { closeCouncil(); $('directive').focus(); return; }
    if (act === 'exec' || act === 'force') { closeCouncil(); runBattle(text); return; }
    if (act === 'alt') { var t = adv.options[0].text; $('directive').value = t; closeCouncil(); runBattle(t); return; }
    if (optIdx != null) { $('directive').value = adv.options[+optIdx].text; openCouncil(); return; } // 선택 후 재심의
  }
  function closeCouncil() { var c = $('council'); if (c) c.className = 'council hidden'; }

  // ===== ★ Doctrine 메모리 — AI 사령관의 영구적 사고방식 ======================
  var doctrines = (function () { try { return JSON.parse(localStorage.getItem('commander_doctrines') || '[]'); } catch (e) { return []; } })();
  var doctrineConflictMemory = (function () {
    try {
      var parsed = JSON.parse(localStorage.getItem('commander_doctrine_conflicts_v1') || 'null');
      if (parsed && parsed.version === 1 && parsed.resolutions && typeof parsed.resolutions === 'object') return parsed;
    } catch (e) {}
    return { version: 1, resolutions: {} };
  })();
  function saveDoctrines() { try { localStorage.setItem('commander_doctrines', JSON.stringify(doctrines)); } catch (e) {} }
  function saveDoctrineConflictMemory() {
    try { localStorage.setItem('commander_doctrine_conflicts_v1', JSON.stringify(doctrineConflictMemory)); } catch (e) {}
  }
  function acceptedDoctrines() { return doctrines.filter(function (d) { return d.status === 'accepted'; }); }

  /**
   * ★ Commander Profile — 이 AI 사령관이 "어떤 사고방식을 가졌는가"의 요약.
   * 새 데이터 없음: 교리 수·총 적용 횟수·평균 신뢰도·대표 교리를 모으기만 한다.
   * 플레이어마다 다른 사령관이 만들어진다는 것을 한눈에 보여준다.
   */
  // ★ Commander Identity — 별명. 지어낸 성격이 아니라, 학습한 교리에서 **유도**한 것.
  //   (support 우선 교리를 가진 사령관 = 지원형 사냥꾼. 성격 생성이 아니라 사실의 요약이다.)
  var IDENTITY = {
    support: '지원형 사냥꾼', ranged: '후방 차단자', frontline: '전열 분쇄자', elite: '정예 척살자'
  };
  function commanderIdentity(acc) {
    if (!acc.length) return null;
    // 가장 많이 적용된 교리의 역할군이 이 사령관의 정체성
    var top = acc[0], topU = -1;
    acc.forEach(function (d) { var u = (d.score || {}).uses || 0; if (u > topU) { topU = u; top = d; } });
    var base = IDENTITY[top.action.targetRole] || '전술가';
    var adaptive = acc.some(function (d) { return d.action.exceptTrait; });
    return (adaptive ? '적응형 ' : '') + base;
  }

  function commanderProfileHTML(acc) {
    if (!acc.length) return '';
    var uses = 0, cUses = 0, cSum = 0, top = null, topU = -1;
    acc.forEach(function (d) {
      var s = d.score || { uses: 0, wins: 0 };
      uses += s.uses;
      var c = window.Doctrine.confidence(d);
      if (c != null) { cUses += s.uses; cSum += c * s.uses; }
      if (s.uses > topU) { topU = s.uses; top = d; }
    });
    var avg = cUses ? Math.round(cSum / cUses) : null;
    return '<div class="cprofile">' +
      '<div class="cp-id"><span class="cp-id-tag">COMMANDER IDENTITY</span>' +
        '<span class="cp-id-name">' + escapeHtml(commanderIdentity(acc)) + '</span></div>' +
      '<div class="cp-row"><span class="cp-k">대표 교리</span><span class="cp-v">' +
        escapeHtml(top ? top.name : '—') + '</span></div>' +
      '<div class="cp-row"><span class="cp-k">평균 신뢰도</span><span class="cp-v">' +
        (avg == null ? '측정 전' : avg + '%') + '</span></div>' +
      '<div class="cp-row"><span class="cp-k">총 적용</span><span class="cp-v">' +
        uses + '회 · 교리 ' + acc.length + '개</span></div>' +
    '</div>';
  }

  function renderDoctrineMem() {
    var el = $('doctrineMem'); if (!el) return;
    var acc = acceptedDoctrines();
    if (!acc.length) {
      el.innerHTML = '<div class="empty">아직 교리가 없습니다. 전투가 끝나면 사령관이 당신의 의도를 분석해 교리를 제안합니다.</div>';
    } else {
      el.innerHTML = commanderProfileHTML(acc) + acc.map(function (d) {
        var c = window.Doctrine.confidence(d);
        var tone = c == null ? '' : c >= 80 ? ' good' : c >= 50 ? ' mid' : ' bad';
        var s = d.score || { uses: 0 };
        var exc = d.action.exceptTrait
          ? ' · 예외: ' + (window.Doctrine.TRAIT_LABEL[d.action.exceptTrait] || d.action.exceptTrait) : '';
        // 이 교리가 어디서 왔는지 — 플레이어 자신의 말에서 시작했다는 것을 보여준다
        var origin = (d.lineage || []).filter(function (x) { return x.step === 'command'; })[0];
        return '<div class="dcard' + (d.action.exceptTrait ? ' has-exc' : '') + '">' +
          '<div class="dc-head"><span class="dc-name">' + escapeHtml(d.name) + '</span>' +
          (c == null ? '' : '<span class="dc-conf' + tone + '">' + c + '%</span>') + '</div>' +
          '<div class="dc-rule">' + escapeHtml(d.rule) + '</div>' +
          (origin ? '<div class="dc-origin">' + escapeHtml(origin.text) + ' 에서 배움</div>' : '') +
          '<div class="dc-tag">대상: ' + escapeHtml(window.Doctrine.ROLE_LABEL[d.action.targetRole] || d.action.targetRole) +
          escapeHtml(exc) + (s.uses ? ' · ' + s.uses + '회 사용' : '') + '</div></div>';
      }).join('');
    }
    var c = $('doctrineCount'); if (c) c.textContent = acc.length + '개 교리';
  }
  function clearDoctrine() {
    doctrines = [];
    doctrineConflictMemory = { version: 1, resolutions: {} };
    saveDoctrines();
    try { localStorage.removeItem('commander_doctrine_conflicts_v1'); } catch (e) {}
    renderDoctrineMem();
    showToast('사령관의 교리를 모두 지웠습니다', 'warn');
  }

  // 지휘 콘솔 모드 전환: 전투 중이면 "규칙 추가", 아니면 "전투 시작"
  function setCmdMode(inBattle) {
    var b = $('start'); if (!b) return;
    b.textContent = inBattle ? '＋ 규칙 추가' : '▶ 전투 시작';
    b.setAttribute('data-mode', inBattle ? 'add' : 'start');
  }

  // ===== ★ Battle Complete — 이 화면이 우리 게임의 얼굴 =======================
  //   Analysis(의도 추론) → New Doctrine(일반화) → Accept / Modify / Reject
  var pendingDoctrine = null;

  /**
   * 이번 전투에 플레이어가 실제로 내린 말 전부. 전투 후 LLM이 볼 원문이다.
   * ⚠ 위치에 기대지 말 것: 빈 명령으로 시작하고 전투 중에 "규칙 추가"로 명령을 넣으면
   *   stack[0]이 최초 명령이 아니다. (그 가정 때문에 명령이 통째로 LLM에 전달되지 않는
   *   버그가 있었다 — 화면엔 보이는데 AI는 "명령이 없었다"고 말하는 상황)
   *   그래서 state.command와 stack의 모든 텍스트를 합치고 중복만 제거한다.
   */
  function battleCommandText() {
    var texts = [state.command].concat(state.stack.map(function (f) { return f.text; }));
    var seen = {}, out = [];
    for (var i = 0; i < texts.length; i++) {
      var t = (texts[i] || '').trim();
      if (!t || seen[t]) continue;
      seen[t] = 1; out.push(t);
    }
    return out.join('. ');
  }

  // **강조**를 <b>로. 의도 추론의 핵심 단어(예: "회복 차단")를 눈에 띄게 한다.
  function emph(s) {
    return escapeHtml(s || '').replace(/\*\*([^*]+)\*\*/g, '<b class="hl">$1</b>');
  }
  /**
   * ★ 데모 종료 화면 — 캠페인을 끝냈을 때 브랜드를 남긴다.
   *   Commander / Doctrine Learned / Battles / Your Words / "Every order becomes a doctrine."
   * 새 데이터 없음: 교리 수·전투 수·명령 수를 모으고 태그라인을 찍을 뿐이다.
   */
  function renderCampaignEnd(show) {
    var el = $('campaignEnd'); if (!el) return;
    if (!show) { el.className = 'campaign-end'; el.innerHTML = ''; return; }
    var learned = acceptedDoctrines().length;
    el.innerHTML =
      '<div class="ce-tag">COMMANDER</div>' +
      '<div class="ce-name">' + escapeHtml(commanderIdentity(acceptedDoctrines()) || '전술가') + '</div>' +
      '<div class="ce-stats">' +
        '<div class="ce-stat"><b>' + learned + '</b><span>Doctrine Learned</span></div>' +
        '<div class="ce-stat"><b>' + cstats.battles + '</b><span>Battles</span></div>' +
        '<div class="ce-stat"><b>' + cstats.orders + '</b><span>Your Words</span></div>' +
      '</div>' +
      '<div class="ce-tagline">Every order becomes a doctrine.</div>';
    el.className = 'campaign-end show';
  }

  function showResult() {
    var el = $('result'); if (!el) return;
    var win = state.winner === 'player', lose = state.winner === 'enemy';
    $('resultBadge').textContent = 'BATTLE COMPLETE';
    $('resultTitle').textContent = win ? '승 리' : lose ? '패 배' : '무승부';
    $('resultSub').textContent = '';
    $('resultNext').style.display = (win && currentStage < STAGES.length - 1) ? '' : 'none';
    el.className = 'result-overlay ' + (win ? 'win' : lose ? 'lose' : 'draw');
    setCmdMode(false);

    // ★ 신뢰도 채점 — 이번 전투에 발동한 교리의 성적을 누적한다.
    //   교리는 만들어지고 끝이 아니라, 매 전투 평가받는다.
    scoreFiredDoctrine(win);
    bumpBattles();

    // ★ Replay — 이 전투의 인과를 한눈에. 심사위원이 3분에 이해하도록.
    renderReplay(win);

    // ★ 캠페인 완료 = 브랜드를 남기는 마지막 화면. 마지막 스테이지를 이겼을 때만.
    renderCampaignEnd(win && currentStage >= STAGES.length - 1);

    // 교리 분석 (비동기)
    pendingDoctrine = null;
    var dv = $('doctrineProposal');
    if (dv) { dv.className = 'dprop thinking'; dv.innerHTML = '<div class="dp-wait">사령관이 이번 전투를 분석하는 중…</div>'; }
    window.Doctrine.analyze({
      // ★ 원문 그대로 넘긴다. 정규식이 이해 못 한 문장이야말로 LLM이 봐야 할 문장이다.
      command: battleCommandText(),
      stageName: STAGES[state.stage].name,
      battle: {
        killedRoles: state.killedRoles,
        enemyRoles: state.enemy.map(function (u) { return u.arch.role; }),
        won: win,
        firedDoctrineId: state.firedDoctrine ? state.firedDoctrine.id : null,
        backfireTraits: state.backfireTraits
      },
      existing: doctrines
    }).then(renderProposal).catch(function () { renderProposal(null); });
  }

  /** 발동한 교리의 사용/성공 횟수를 누적 → 신뢰도(confidence) */
  function scoreFiredDoctrine(win) {
    var fd = state.firedDoctrine; if (!fd) return;
    var d = doctrines.filter(function (x) { return x.id === fd.id; })[0]; if (!d) return;
    d.score = d.score || { uses: 0, wins: 0, losses: 0 };
    d.score.uses++;
    if (win) d.score.wins++; else d.score.losses++;
    saveDoctrines(); renderDoctrineMem();
  }

  /**
   * ★ 교리의 진화 — 연출이 아니라 **기록**을 읽어서 그린다.
   *   당신의 말 → AI가 읽은 의도 → 일반화된 원리 → (예외)
   * 각 단계는 실제로 일어난 시점에 lineage에 쌓인 것이고, 여기선 순서대로 드러낼 뿐이다.
   * 한 칸씩 늦게 나타나는 건 계산을 흉내내는 게 아니라, 이미 있는 사실을 읽히게 하는 것.
   */
  function evolutionHTML(lineage) {
    if (!lineage || !lineage.length) return '';
    return '<div class="evo">' + lineage.map(function (s, i) {
      return (i ? '<div class="evo-arrow" style="animation-delay:' + (i * 0.42 - 0.12) + 's">↓</div>' : '') +
        '<div class="evo-step ' + s.step + '" style="animation-delay:' + (i * 0.42) + 's">' +
          '<span class="evo-label">' + escapeHtml(s.label) +
            (s.stage ? ' <i>· ' + escapeHtml(s.stage) + '</i>' : '') + '</span>' +
          '<span class="evo-text">' + escapeHtml(s.text) + '</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  /**
   * ★ Replay — 이 전투의 인과 사슬을 한 줄로 재생한다.
   *   당신의 말 → AI가 이해한 의도 → 적용된 교리 → 실제 제거 순서 → 결과
   * 새 데이터는 없다. 이미 기록된 것(명령·intent·firedDoctrine·killedRoles)을 잇기만 한다.
   * 심사위원이 "왜 이렇게 됐지?"를 스스로 답하게 만드는 것이 목적.
   */
  function renderReplay(win) {
    var el = $('replay'); if (!el) return;
    var steps = [];
    var cmd = battleCommandText();

    // ① 플레이어의 말 (없으면 '명령 없음'을 정직하게)
    steps.push(cmd
      ? { k: 'say', label: '당신의 말', text: '“' + cmd + '”' }
      : { k: 'say none', label: '당신의 말', text: '(침묵 — 사령관에게 맡김)' });

    // ② 사령관이 이해한 의도 (해석기 결과)
    var it = state.intent || {};
    if (it.understood && (it.why || (it.rules && it.rules.length)))
      steps.push({ k: 'intent', label: '사령관 이해', text: it.why || it.rules[0] });

    // ③ 적용된 교리 (자율 발동한 것 — 명령이 덮어썼으면 null이라 표시 안 함)
    var fd = state.firedDoctrine;
    if (fd) steps.push({ k: 'doctrine', label: '적용된 교리', text: fd.name });

    // ④ 실제로 일어난 일 — 제거된 적 역할군 순서 (말이 아니라 행동)
    var kr = (state.killedRoles || []).map(function (r) { return window.Doctrine.ROLE_LABEL[r] || r; });
    if (kr.length) {
      var uniq = [], seen = {};
      for (var i = 0; i < kr.length; i++) { if (!seen[kr[i]]) { seen[kr[i]] = 1; uniq.push(kr[i]); } }
      steps.push({ k: 'act', label: '제거 순서', text: uniq.join(' → ') });
    }

    // ⑤ 결과
    steps.push({ k: 'result ' + (win ? 'win' : 'lose'), label: '결과', text: win ? '승리' : '패배' });

    el.className = 'replay show';
    el.innerHTML = '<div class="rp-tag">REPLAY · 이 전투에 무슨 일이 있었나</div>' +
      '<div class="rp-chain">' + steps.map(function (s, i) {
        return (i ? '<span class="rp-arrow" style="animation-delay:' + (i * 0.35 - 0.1) + 's">→</span>' : '') +
          '<span class="rp-node ' + s.k + '" style="animation-delay:' + (i * 0.35) + 's">' +
            '<b>' + escapeHtml(s.label) + '</b>' + escapeHtml(s.text) + '</span>';
      }).join('') + '</div>';
  }

  /** 신뢰도 표 — 교리가 매 전투 평가받는다는 것을 보여준다 */
  function scoreHTML(scores) {
    if (!scores || !scores.length) return '';
    var rows = scores.filter(function (s) { return s.uses > 0; }).map(function (s) {
      var c = s.confidence;
      var tone = c == null ? '' : c >= 80 ? ' good' : c >= 50 ? ' mid' : ' bad';
      return '<div class="ds-row"><span class="ds-name">' + escapeHtml(s.name) + '</span>' +
        '<span class="ds-use">' + s.uses + '회 · 성공 ' + s.wins + ' · 실패 ' + s.losses + '</span>' +
        '<span class="ds-conf' + tone + '">' + (c == null ? '—' : c + '%') + '</span></div>';
    }).join('');
    if (!rows) return '';
    return '<div class="dp-sec"><div class="dp-h">DOCTRINE SCORE</div><div class="ds">' + rows + '</div></div>';
  }

  /**
   * ★ Next Battle Prediction — 이 교리가 미래에 언제 발동할지 한 줄로 설명.
   * 새 기능이 아니다: applyTo의 조건 판정 로직을 사람 말로 옮긴 것뿐이다.
   * 심사위원이 "아, 다음에도 쓰이는구나"를 바로 이해하게 한다.
   */
  function predictionText(d) {
    var TL = window.Doctrine.TRAIT_LABEL;
    var when = (d.condition && d.condition.requiresTrait)
      ? (TL[d.condition.requiresTrait] || '') + ' 특성의 적이 있는 전투'
      : '모든 전투';
    var s = '다음부터 ' + when + '에서 자동 적용됩니다';
    if (d.action.exceptTrait) s += ' (단, ' + (TL[d.action.exceptTrait] || '') + '형은 제외)';
    return s + '.';
  }

  function doctrineConflictHTML() {
    var conflict = state && state.doctrineConflict;
    if (!conflict) return '';
    var contenders = conflict.contenderIds.map(function (id) {
      return doctrines.filter(function (d) { return d.id === id; })[0] || { id: id, name: id };
    });
    var selectedId = state.firedDoctrine ? state.firedDoctrine.id
      : (conflict.resolvedWinnerId || conflict.legacyWinnerId);
    var selected = contenders.filter(function (d) { return d.id === selectedId; })[0];
    var buttons = contenders.map(function (d) {
      var chosen = conflict.resolvedWinnerId === d.id;
      return '<button type="button" class="dcf-btn' + (chosen ? ' selected' : '') + '"' +
        ' data-conflict-winner="' + encodeURIComponent(d.id) + '" aria-pressed="' + chosen + '">' +
        escapeHtml(d.name) + '</button>';
    }).join('');
    var note = conflict.resolvedWinnerId
      ? '저장된 우선순위를 이번 전투에 적용했습니다.'
      : '선택은 다음 동일 충돌부터 적용됩니다.';
    return '<div class="dp-sec doctrine-conflict">' +
      '<div class="dp-h">DOCTRINE CONFLICT</div>' +
      '<div class="dcf-title">교리 충돌</div>' +
      '<div class="dcf-contenders">' + contenders.map(function (d) { return escapeHtml(d.name); }).join(' / ') + '</div>' +
      '<div class="dcf-current"><span>이번 전투</span><b>' + escapeHtml(selected ? selected.name : selectedId) + '</b></div>' +
      '<div class="dcf-label">다음부터</div>' +
      '<div class="dcf-actions">' + buttons + '</div>' +
      '<div class="dcf-status" aria-live="polite">' + note + '</div>' +
    '</div>';
  }

  function bindDoctrineConflictActions() {
    var dv = $('doctrineProposal');
    var conflict = state && state.doctrineConflict;
    if (!dv || !conflict) return;
    Array.prototype.forEach.call(dv.querySelectorAll('[data-conflict-winner]'), function (button) {
      button.addEventListener('click', function () {
        var winnerId = decodeURIComponent(button.getAttribute('data-conflict-winner'));
        if (conflict.contenderIds.indexOf(winnerId) === -1) return;
        doctrineConflictMemory.resolutions[conflict.key] = { winnerId: winnerId };
        saveDoctrineConflictMemory();
        Array.prototype.forEach.call(dv.querySelectorAll('[data-conflict-winner]'), function (choice) {
          var selected = decodeURIComponent(choice.getAttribute('data-conflict-winner')) === winnerId;
          choice.classList.toggle('selected', selected);
          choice.setAttribute('aria-pressed', selected ? 'true' : 'false');
        });
        var winner = doctrines.filter(function (d) { return d.id === winnerId; })[0];
        var status = dv.querySelector('.dcf-status');
        if (status) status.textContent = '다음 동일 충돌부터 ' + (winner ? winner.name : winnerId) + ' 교리를 우선합니다.';
      });
    });
  }

  function renderProposal(res) {
    var dv = $('doctrineProposal'); if (!dv) return;
    var conflict = doctrineConflictHTML();
    if (!res) {
      dv.className = 'dprop none';
      dv.innerHTML = conflict + '<div class="dp-wait">분석에 실패했습니다.</div>';
      bindDoctrineConflictActions();
      return;
    }

    var head = '<div class="dp-sec"><div class="dp-h">ANALYSIS' +
      '<span class="dp-backend">' + escapeHtml(window.Doctrine.backendLabel()) + '</span>' +
      '</div><div class="dp-body">' + emph(res.analysis) + '</div></div>';

    // ★ 배울 게 없어도 화면이 죽지 않는다 — 신뢰도를 보고한다.
    if (res.kind === 'report' || !res.doctrine) {
      pendingDoctrine = null;
      dv.className = 'dprop none';
      dv.innerHTML = conflict + head + scoreHTML(res.scores);
      bindDoctrineConflictActions();
      return;
    }

    pendingDoctrine = res.doctrine;
    var d = res.doctrine;
    var isExc = res.kind === 'exception';
    dv.className = 'dprop' + (isExc ? ' exception' : '');
    dv.innerHTML =
      conflict + head + scoreHTML(res.scores) +
      '<div class="dp-sec new"><div class="dp-h">' + (isExc ? '⚠ EXCEPTION LEARNED' : 'NEW DOCTRINE') + '</div>' +
        '<div class="dp-name">' + escapeHtml(d.name) + '</div>' +
        '<div class="dp-rule">' + escapeHtml(d.rule) + '</div>' +
        '<div class="dp-reason">' + emph(d.reason) + '</div>' +
        // ★ Next Battle Prediction — 이 교리가 '미래'에 언제 쓰일지. 기능이 아니라 설명.
        '<div class="dp-predict"><span class="dp-predict-tag">NEXT BATTLE</span>' + escapeHtml(predictionText(d)) + '</div>' +
      '</div>' +
      '<div class="dp-actions">' +
        '<button class="dbtn accept" data-d="accept">✓ 채택 <i>Adopt</i></button>' +
        '<button class="dbtn" data-d="modify">✎ 다듬기</button>' +
        '<button class="dbtn ghost" data-d="reject">✕ 보류</button>' +
      '</div>';
    Array.prototype.forEach.call(dv.querySelectorAll('[data-d]'), function (b) {
      b.addEventListener('click', function () { doctrineAction(b.getAttribute('data-d')); });
    });
    bindDoctrineConflictActions();
  }

  function doctrineAction(act) {
    if (!pendingDoctrine) return;
    var dv = $('doctrineProposal');
    if (act === 'reject') {
      dv.className = 'dprop none';
      dv.innerHTML = '<div class="dp-wait">교리를 거부했습니다. AI는 이 전투에서 배우지 않습니다.</div>';
      pendingDoctrine = null; return;
    }
    if (act === 'modify') {
      var cur = pendingDoctrine.rule;
      var next = prompt('교리를 수정하세요 (AI가 따를 규칙):', cur);
      if (next == null) return;
      pendingDoctrine.rule = next.trim() || cur;
      pendingDoctrine.modified = true;
    }
    pendingDoctrine.status = 'accepted';
    // 같은 역할군의 기존 교리는 대체된다. 예외 교리는 원본 규칙을 포함하므로
    // 원본을 지우고 들어가는 것이 맞다(교리가 늘어나는 게 아니라 **정교해지는** 것).
    var wasExc = !!pendingDoctrine.action.exceptTrait;
    var d = pendingDoctrine;
    doctrines = doctrines.filter(function (x) { return x.action.targetRole !== d.action.targetRole; });
    doctrines.push(d);
    saveDoctrines(); renderDoctrineMem();
    // ★ 채택 순간 = 이 교리가 '어떻게 여기까지 왔는지'를 보여주는 순간.
    //   구어체 → 의도 → 원리 → (예외). 전부 실제로 기록된 단계다.
    dv.className = 'dprop accepted';
    dv.innerHTML =
      '<div class="dp-sec"><div class="dp-h">' + (wasExc ? 'DOCTRINE REFINED' : 'DOCTRINE SAVED') + '</div>' +
        evolutionHTML(d.lineage) +
      '</div>' +
      '<div class="dp-ok">✓ <b>' + escapeHtml(d.name) + '</b><br>' +
      '<span>' + escapeHtml(predictionText(d)) + '</span></div>';
    pendingDoctrine = null;
  }
  function hideResult() {
    var el = $('result'); if (el) el.className = 'result-overlay hidden';
    var rp = $('replay'); if (rp) rp.className = 'replay';
    var ce = $('campaignEnd'); if (ce) ce.className = 'campaign-end';
  }

  var PRESETS = {
    charge: '전 부대 공격적으로 돌격한다. 화력을 한 명에게 집중해서 몰아쳐라.',
    snipe: '적 힐러에게 화력을 집중해 먼저 처치하고, 궁수는 카이팅한다.',
    cut: '적 원거리 유닛에 화력을 집중해 먼저 끊어라.',
    weak: '체력 낮은 적부터 화력을 집중해 빠르게 수를 줄여라.',
    evade: '폭격·붕괴 위험 지대를 즉시 피해라.',
    regroup: '아군을 한데 뭉쳐 대형을 유지해라.'
  };

  // ---- 스테이지 선택 ---------------------------------------------------------
  // 클리어 표시. (별 시스템은 제거 — 이 게임의 보상은 별이 아니라 AI가 배운 교리다.
  //  progress는 스테이지 해금 판정에만 내부적으로 쓰인다.)
  function clearHTML(cleared) {
    return cleared ? '<span class="sc-clear">✓ CLEAR</span>' : '';
  }
  function renderStageSelect() {
    var grid = $('stageGrid'); if (!grid) return;
    var html = '';
    for (var i = 0; i < STAGES.length; i++) {
      // 잠긴 스테이지는 CLEAR를 표시하지 않는다(해금 안 됐는데 클리어 표기는 모순).
      var s = STAGES[i], unlocked = stageUnlocked(i), cleared = unlocked && (progress[s.id] || 0) >= 1;
      html += '<button class="stage-card' + (unlocked ? '' : ' locked') + (s.proof ? ' proof' : '') +
        '" data-stage="' + i + '"' + (unlocked ? '' : ' disabled') + '>' +
        '<div class="sc-top"><span class="sc-no">STAGE ' + s.id + '</span>' +
        '<span class="sc-diff">' + diffDots(s.diff) + '</span></div>' +
        '<div class="sc-name">' + (unlocked ? escapeHtml(s.name) : '🔒 잠김') + '</div>' +
        '<div class="sc-sub">' + (unlocked ? escapeHtml(s.sub) : '앞 스테이지를 클리어하세요') + '</div>' +
        '<div class="sc-stars">' + clearHTML(cleared) + '</div>' +
        '</button>';
    }
    grid.innerHTML = html;
    var tEl = $('ssTotalStars'); if (tEl) tEl.textContent = acceptedDoctrines().length;
    var cards = grid.querySelectorAll('[data-stage]');
    for (var k = 0; k < cards.length; k++) cards[k].addEventListener('click', function (e) {
      var idx = +e.currentTarget.getAttribute('data-stage');
      if (stageUnlocked(idx)) enterStage(idx);
    });
  }
  function diffDots(d) { var h = ''; for (var i = 0; i < 5; i++) h += '<i class="' + (i < d ? 'on' : '') + '"></i>'; return h; }

  function showStageSelect() {
    running = false;
    $('titleScreen').classList.add('hidden');
    $('gameScreen').classList.add('hidden');
    $('stageScreen').classList.remove('hidden');
    renderStageSelect();
  }
  function enterStage(idx) {
    currentStage = idx;
    $('stageScreen').classList.add('hidden');
    $('gameScreen').classList.remove('hidden');
    $('enemyRead').innerHTML = '';
    // ★ 교리는 명령창에 채우지 않는다. 텍스트가 아니라 AI의 사고방식이므로
    //   플레이어가 아무 것도 입력하지 않아도 스스로 적용된다. (newBattle 참고)
    $('directive').value = '';
    hideResult(); resizeCanvas(); deployPreview(); updateHUD(); draw();
  }
  window.__revealStages = showStageSelect;   // 타이틀에서 호출

  function bind() {
    $('start').addEventListener('click', function () {
      if ($('start').getAttribute('data-mode') === 'add') { addRule(); return; }
      if (FEATURES.warCouncil) openCouncil(); else runBattle($('directive').value.trim());
    });
    var wcC = $('wcClose'); if (wcC) wcC.addEventListener('click', closeCouncil);
    $('doctrineClear').addEventListener('click', clearDoctrine);
    $('directive').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('start').click(); }
    });
    $('reset').addEventListener('click', resetBattle);
    $('resultAgain').addEventListener('click', function () { hideResult(); deployPreview(); $('directive').focus(); });
    $('resultSelect').addEventListener('click', showStageSelect);
    $('resultNext').addEventListener('click', function () {
      if (currentStage < STAGES.length - 1) enterStage(currentStage + 1);
    });
    $('btnStageSelect').addEventListener('click', showStageSelect);
    $('ssBackTitle').addEventListener('click', function () {
      $('stageScreen').classList.add('hidden'); $('titleScreen').classList.remove('hidden');
    });
    $('sp1').addEventListener('click', function () { setSpeed(1); });
    $('sp2').addEventListener('click', function () { setSpeed(2); });
    $('sp4').addEventListener('click', function () { setSpeed(4); });
    var pb = document.querySelectorAll('[data-preset]');
    for (var i = 0; i < pb.length; i++) pb[i].addEventListener('click', function (e) {
      $('directive').value = PRESETS[e.currentTarget.getAttribute('data-preset')];
      $('directive').focus();
    });
    window.addEventListener('resize', resizeCanvas);
  }
  function setSpeed(s) {
    speed = s;
    ['sp1', 'sp2', 'sp4'].forEach(function (id) { $(id).classList.remove('active'); });
    $('sp' + s).classList.add('active');
  }

  // 컨테이너에 맞춘 반응형 캔버스 (레티나 대응)
  function resizeCanvas() {
    if (!canvas) return;
    var host = canvas.parentElement;
    W = Math.max(360, host.clientWidth);
    H = Math.max(280, host.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // 타이틀 화면에서 게임 진입 시 호출 (캔버스 크기 확정 후 부대 배치 프리뷰)
  window.__revealGame = function () {
    resizeCanvas(); deployPreview(); updateHUD(); draw();
  };

  window.addEventListener('DOMContentLoaded', function () {
    canvas = $('arena'); ctx = canvas.getContext('2d');
    resizeCanvas();
    bind(); setSpeed(2); updateHUD(); renderDoctrineMem();
    // 프록시에 키가 있으면 LLM으로 승격 (없으면 로컬 규칙 엔진으로 동작)
    if (window.Doctrine && window.Doctrine.probe) window.Doctrine.probe();
    if (FEATURES.warCouncil && window.Advisor && window.Advisor.probe) window.Advisor.probe();
    requestAnimationFrame(loop);
  });
})();
