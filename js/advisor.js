/* =============================================================================
 * advisor.js — AI 사령관 (팀원 두뇌)
 * -----------------------------------------------------------------------------
 * 명령을 "실행"만 하지 않는다. 헤드리스 시뮬레이터로 미래를 예측해
 * 근거 있는 반론·질문·동의를 내놓는다. (= 이 게임에서 LLM이 핵심인 이유)
 *
 *   advise(ctx) -> Promise<advice>
 *     ctx     = { command, stack, stage, board }
 *     advice  = { stance:'agree'|'warn'|'question',
 *                 interpretation, message,
 *                 forecastPlan:{win,wipe,surv}, forecastAlt:{win,...}|null,
 *                 alt:{text,label}|null, options:[{text,label}]|null }
 *
 * 지금은 로컬(시뮬레이터 근거)로 동작. 프록시(/api/advise)가 살아있으면 실제
 * Claude로 자동 승격 — 계약이 같아 게임 루프는 바뀌지 않는다.
 * ========================================================================== */
(function (global) {
  'use strict';
  var Brain = global.CommanderBrain;
  var FN = 22; // 예측 표본 수 (이벤트 랜덤성 때문에 넉넉히)

  function fc(dir, stage) { return global.Commander.forecast(dir, stage, FN); }
  function stackText(stack, extra) {
    var arr = stack.map(function (f) { return f.text; }).filter(Boolean);
    if (extra) arr.push(extra);
    return arr.join('. ');
  }

  // 위험한 명령에 대한 "더 나은 대안"을 휴리스틱으로 생성
  function altFor(frag) {
    var s = frag.set;
    if (s.targetPriority === 'healer') return { text: '가장 강한 적(탱커)부터 화력을 집중', label: '탱커 우선' };
    if (s.aggression != null && s.aggression > 0.7) return { text: '신중하게, 체력 35% 이하 후퇴', label: '신중·후퇴' };
    if (s.kite) return { text: '공격적으로 돌격해 화력을 한 명에게 집중', label: '돌격·집중' };
    if (s.avoidHazards) return { text: '위험지대를 피하며 화력을 집중', label: '회피+집중' };
    return { text: '적 원거리 유닛을 먼저 끊어라', label: '원거리 차단' };
  }

  // ---- 로컬 어드바이저 (시뮬레이터 근거) ----
  function adviseLocal(ctx) {
    var frag = Brain.parseFragment(ctx.command || '');

    // 명령이 모호 → 되묻는다
    if (!frag.matched) {
      return Promise.resolve({
        stance: 'question',
        interpretation: '명령이 모호합니다.',
        message: '누구를, 어떻게 공격할까요?',
        options: [
          { text: '적 힐러에게 화력을 집중해 먼저 처치', label: '적 힐러 집중' },
          { text: '가장 강한 적(보스)부터 화력을 집중', label: '강적 집중' },
          { text: '가장 가까운 적과 교전', label: '근접 교전' }
        ],
        forecastPlan: null, forecastAlt: null, alt: null
      });
    }

    var planText = stackText(ctx.stack, ctx.command);
    var alt = altFor(frag);
    var altText = stackText(ctx.stack, alt.text);
    var fp = fc(planText, ctx.stage);
    var fa = fc(altText, ctx.stage);

    var stance, msg, gap = fa.win - fp.win;
    if ((fp.wipe >= 38 || fp.win <= 32) && gap >= 10) {
      stance = 'warn';   // 위험 + 더 나은 길 존재
      msg = '위험합니다. 그 명령은 예측 승률 ' + fp.win + '%, 전멸 확률 ' + fp.wipe + '%입니다. '
        + '대신 "' + alt.label + '"이면 승률이 ' + fa.win + '%로 오릅니다. 그래도 강행할까요?';
    } else if (gap >= 18) {
      stance = 'warn';   // 실행은 가능하나 뚜렷이 더 나은 대안
      msg = '실행은 가능합니다(승률 ' + fp.win + '%). 다만 "' + alt.label + '"이 ' + fa.win + '%로 더 안전합니다. 어느 쪽으로 갈까요?';
    } else if (fp.win >= 55) {
      stance = 'agree';
      msg = '좋은 판단입니다. 예측 승률 ' + fp.win + '% (전멸 ' + fp.wipe + '%). 이대로 실행하겠습니다.';
    } else {
      stance = 'agree';
      msg = '실행 가능합니다. 예측 승률 ' + fp.win + '% (전멸 ' + fp.wipe + '%). 필요하면 규칙을 더 얹으세요.';
    }

    return Promise.resolve({
      stance: stance,
      interpretation: frag.rules.join(' · '),
      message: msg,
      forecastPlan: fp, forecastAlt: fa, alt: alt,
      options: stance === 'warn' ? [{ text: alt.text, label: '대안 채택 (' + fa.win + '%)' }] : null
    });
  }

  // ---- Claude 어댑터 (프록시 있으면 승격, 동일 계약) ----
  // 시뮬레이터(진실)로 예측을 계산해 프록시에 넘기고, Claude는 근거 기반 대사를 생성.
  function adviseClaude(ctx) {
    var frag = Brain.parseFragment(ctx.command || '');
    var alt = altFor(frag);
    var fp = frag.matched ? fc(stackText(ctx.stack, ctx.command), ctx.stage) : null;
    var fa = frag.matched ? fc(stackText(ctx.stack, alt.text), ctx.stage) : null;
    return fetch('/api/advise', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: ctx.command, board: ctx.board, doctrine: (ctx.stack || []).map(function (f) { return f.text; }),
        forecasts: { plan: fp, alt: fa, altLabel: alt.label, altText: alt.text } })
    }).then(function (r) { if (!r.ok) throw new Error('proxy ' + r.status); return r.json(); })
      .then(function (res) {
        return {
          stance: res.stance,
          interpretation: res.interpretation || frag.rules.join(' · '),
          message: res.message,
          forecastPlan: fp, forecastAlt: fa, alt: alt,
          options: res.options && res.options.length ? res.options
            : (res.stance === 'warn' ? [{ text: alt.text, label: '대안 채택' + (fa ? ' (' + fa.win + '%)' : '') }] : null)
        };
      });
  }

  var useClaude = false;
  global.Advisor = {
    advise: function (ctx) {
      if (useClaude) return adviseClaude(ctx).catch(function () { return adviseLocal(ctx); });
      return adviseLocal(ctx);
    },
    backend: function () { return useClaude ? 'claude' : 'local'; },
    // 프록시 헬스체크 → 살아있으면 실제 Claude로 자동 승격
    probe: function () {
      return fetch('/api/health').then(function (r) { useClaude = r.ok; return useClaude; })
        .catch(function () { useClaude = false; return false; });
    }
  };
})(window);
