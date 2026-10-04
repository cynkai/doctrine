/* =============================================================================
 * proxy.js — AI 사령관 백엔드 (선택) : LLM 의도 추론
 * -----------------------------------------------------------------------------
 * 브라우저에서 LLM API를 직접 부르면 키가 노출되므로 이 작은 로컬 프록시가
 * 중계한다. 정적 게임도 함께 서빙하므로 이 서버 하나만 켜면 된다.
 *
 * 실행 (키는 각자 자기 것을 넣는다):
 *   OPENAI_API_KEY=sk-... node server/proxy.js        # → http://localhost:8731
 *
 * 키가 없으면 /api/health가 503을 반환 → 프런트가 자동으로 규칙 기반 폴백으로
 * 동작한다. 키를 넣고 켜면 프런트가 자동으로 LLM으로 승격한다.
 * 의존성 없음(Node 18+ 내장 fetch 사용).
 *
 * LLM은 의도 해석만 한다. 출력은 json_schema로 게임이 아는 값에 묶이고,
 * 전투 결과는 브라우저의 시뮬레이터가 정한다.
 *   LLM = 해석 / 시뮬레이터 = 진실.
 * ========================================================================== */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const guard = require('./guard');

const PORT = process.env.PORT || 8731;
const ROOT = path.join(__dirname, '..');

/* ---------------------------------------------------------------------------
 * 프로바이더 스위치 — 키가 있는 쪽을 자동으로 쓴다. 둘 다 있으면 OPENAI 우선.
 *   OPENAI_API_KEY=sk-...     node server/proxy.js
 *   ANTHROPIC_API_KEY=sk-ant-... node server/proxy.js
 *   COMMANDER_PROVIDER=anthropic 로 강제 지정 가능.
 * 두 어댑터는 완전히 같은 계약을 지킨다: ctx -> {analysis, doctrine:{role,...}}
 * 그래서 프런트(js/doctrine.js)는 어느 쪽인지 알 필요가 없다.
 * ------------------------------------------------------------------------- */
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = process.env.COMMANDER_PROVIDER || (OPENAI_KEY ? 'openai' : ANTHROPIC_KEY ? 'anthropic' : '');
const HAS_KEY = PROVIDER === 'openai' ? !!OPENAI_KEY : PROVIDER === 'anthropic' ? !!ANTHROPIC_KEY : false;
const MODEL = process.env.COMMANDER_MODEL ||
  (PROVIDER === 'openai' ? 'gpt-5.4-mini' : 'claude-opus-4-8');

const API_KEY = ANTHROPIC_KEY;   // (레거시: /api/advise 작전회의용 — 예선 스코프에서 OFF)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const SYSTEM = [
  '당신은 자연어로 지휘하는 전술 오토배틀러의 "AI 사령관"이다. 플레이어의 팀원으로서,',
  '명령을 그대로 실행만 하지 않고 함께 심의한다. 게임 엔진의 시뮬레이터가 제공한 예측',
  '(이 명령의 승률/전멸률, 그리고 더 나은 대안의 승률)을 근거로 판단하라.',
  '- 명령이 명백히 위험하거나 뚜렷이 더 나은 대안이 있으면 stance="warn"으로 짧게 반론하고 대안을 제시.',
  '- 명령이 모호하면(대상/방식 불명) stance="question"으로 되묻고 2~3개 선택지를 제시.',
  '- 합리적이면 stance="agree".',
  '한국어로, 1~2문장으로 간결하게. 예측 수치를 반드시 근거로 인용하라.',
  'JSON만 출력한다.'
].join(' ');

function adviseSchema() {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      stance: { type: 'string', enum: ['agree', 'warn', 'question'] },
      interpretation: { type: 'string' },
      message: { type: 'string' },
      options: {
        type: 'array',
        items: { type: 'object', additionalProperties: false,
          properties: { text: { type: 'string' }, label: { type: 'string' } },
          required: ['text', 'label'] }
      }
    },
    required: ['stance', 'message']
  };
}

async function callClaude(ctx) {
  const f = ctx.forecasts || {};
  const userText = [
    '전장: ' + JSON.stringify(ctx.board),
    '현재 교범(누적 규칙): ' + JSON.stringify(ctx.doctrine || []),
    '플레이어 명령: "' + (ctx.command || '(없음)') + '"',
    '시뮬레이터 예측 — 이 명령: ' + (f.plan ? ('승률 ' + f.plan.win + '%, 전멸 ' + f.plan.wipe + '%') : '없음(명령 모호)'),
    '시뮬레이터 예측 — 대안(' + (f.altLabel || '대안') + '): ' + (f.alt ? ('승률 ' + f.alt.win + '%, 전멸 ' + f.alt.wipe + '%') : '없음'),
    '대안 명령 텍스트: "' + (f.altText || '') + '"',
    '위 근거로 stance(agree|warn|question), message(한국어 1~2문장), 필요 시 options[{text,label}]를 정하라.',
    'warn이면 대안 명령을 options[0].text로 제시. question이면 선택지 2~3개를 options로.'
  ].join('\n');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: adviseSchema() } },
      system: SYSTEM,
      messages: [{ role: 'user', content: userText }]
    })
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const textBlock = (data.content || []).find(function (b) { return b.type === 'text'; });
  if (!textBlock) throw new Error('no text block');
  return JSON.parse(textBlock.text);
}

/* ===========================================================================
 * ★ /api/intent — Intent Extraction (전투 전)
 *   플레이어의 **임의의 자연어**를 이번 전투의 정책으로 번역한다.
 *
 * 이것이 "왜 LLM이 아니면 안 되는가"의 답이다. 정규식은 사전에 있는 표현만 잡는다:
 *   "힐러 먼저"              → 정규식 O
 *   "쟤 하나 때문에 안 죽잖아" → 정규식 X  ← 심사위원은 이렇게 친다
 *   "뒤부터 죽여"            → 정규식 X
 * LLM은 셋 다 이해한다. 사람은 사전에 있는 말로 말하지 않는다.
 *
 * 출력은 json_schema로 게임이 아는 값(role/trait enum)에 강제 제약된다.
 * → LLM은 게임 규칙을 지어내지 못하고, 오직 **의도 해석**만 담당한다.
 * ======================================================================== */
const INTENT_SYSTEM = [
  '당신은 전술 오토배틀러의 "AI 사령관"이다. 플레이어(사령관)가 자연어로 내린 명령을 읽고,',
  '부대가 실행할 **정책**으로 번역한다.',
  '',
  '★ 핵심: 플레이어는 게임 용어로 말하지 않는다. 일상어·비유·불평으로 말한다.',
  '  "쟤 하나 때문에 안 죽잖아"     → 회복시켜주는 적이 있다 → targetRole="support"',
  '  "뒤부터 죽여"                 → 후방의 원거리·지원 유닛부터 → targetRole="ranged"',
  '  "뒤에 깃발 든 애 거슬려"       → 버퍼(지원형) → targetRole="support"',
  '  "몰아쳐"                      → focusFire=true, aggression 높게',
  '  "무리하지 마"                 → aggression 낮게, retreatHpPct 설정',
  '  "방패 든 애는 무시하고 지나가" → 그 전열형은 치지 않는다 → avoidRole="frontline", targetRole=null',
  '표면의 단어가 아니라 **의도**를 읽어라.',
  '',
  '규칙:',
  '1) targetRole은 주어진 role 목록 중 하나이거나 null이다. 지어내지 마라.',
  '2) 명령에 대상 지시가 전혀 없으면 targetRole=null로 두고, 다른 필드만 채워라.',
  '   "무시해/건드리지 마/지나가"처럼 **피하라는** 대상은 targetRole이 아니라 avoidRole이다.',
  '   avoidRole과 targetRole은 같은 역할군일 수 없다.',
  '2-1) aggression과 retreatHpPct는 0~1 사이 비율이다. 체력 60%면 0.6 (60이 아니다).',
  '3) 전혀 전술 명령이 아니면(예: "안녕", "ㅋㅋ") understood=false.',
  '4) rules[]에는 "AI가 이렇게 이해했다"를 플레이어가 읽을 짧은 한국어 문구로 1~3개 넣어라.',
  '   예) ["적 지원형을 최우선 제거", "화력 집중"]  ← 8~20자, 존댓말 불필요(라벨이므로)',
  '5) why는 그 판단의 핵심 의도를 4~10자로. 예) "회복 차단"',
  'JSON만 출력한다.'
].join('\n');

function intentSchema(roleKeys, traitKeys) {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      understood: { type: 'boolean' },
      targetRole: { type: ['string', 'null'], enum: roleKeys.concat([null]) },
      exceptTrait: { type: ['string', 'null'], enum: traitKeys.concat([null]) },
      avoidRole: { type: ['string', 'null'], enum: roleKeys.concat([null]) },
      focusFire: { type: 'boolean' },
      kite: { type: 'boolean' },
      aggression: { type: ['number', 'null'] },      // 0..1
      retreatHpPct: { type: ['number', 'null'] },    // 0..1
      why: { type: 'string' },
      rules: { type: 'array', items: { type: 'string' } }
    },
    required: ['understood', 'targetRole', 'exceptTrait', 'avoidRole', 'focusFire', 'kite',
      'aggression', 'retreatHpPct', 'why', 'rules']
  };
}

function intentPrompt(ctx) {
  return [
    '역할군 목록(targetRole은 반드시 이 중 하나 또는 null): ' + JSON.stringify(ctx.roles || []),
    '특성 목록(exceptTrait용): ' + JSON.stringify(ctx.traits || []),
    '이번 전장의 적 구성: ' + JSON.stringify(ctx.enemies || []),
    '',
    '플레이어 명령: "' + (ctx.command || '') + '"',
    '',
    '이 명령의 의도를 읽어 정책으로 번역하라.'
  ].join('\n');
}

async function callIntent(body) {
  const ctx = guard.intentCtx(body);
  const roleKeys = (ctx.roles || []).map(function (r) { return r.key; });
  const traitKeys = (ctx.traits || []).map(function (t) { return t.key; });
  if (PROVIDER === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + OPENAI_KEY },
      body: JSON.stringify({
        model: MODEL, max_completion_tokens: guard.MAX_OUTPUT_TOKENS,
        messages: [{ role: 'system', content: INTENT_SYSTEM }, { role: 'user', content: intentPrompt(ctx) }],
        response_format: { type: 'json_schema',
          json_schema: { name: 'intent', strict: true, schema: intentSchema(roleKeys, traitKeys) } }
      })
    });
    if (!res.ok) throw new Error('openai ' + res.status + ' ' + (await res.text()).slice(0, 300));
    const data = await res.json();
    const msg = data.choices && data.choices[0] && data.choices[0].message;
    if (!msg || !msg.content) throw new Error('no content');
    return JSON.parse(msg.content);
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024, thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: intentSchema(roleKeys, traitKeys) } },
      system: INTENT_SYSTEM,
      messages: [{ role: 'user', content: intentPrompt(ctx) }]
    })
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const tb = (data.content || []).find(function (b) { return b.type === 'text'; });
  if (!tb) throw new Error('no text block');
  return JSON.parse(tb.text);
}

/* ===========================================================================
 * ★ /api/doctrine — 이 게임의 심장
 *   Player Prompt → Intent Extraction → Doctrine Generator → Doctrine Memory
 * LLM이 하는 일은 "명령 실행"이 아니라 **의도 추론과 일반화**다.
 *   "힐러 먼저" → 의도: 회복 차단 → 일반화: 지원형(support) 우선 제거
 * 일반화의 대상은 반드시 유닛 이름이 아니라 역할군(role)이어야 한다.
 * 그래야 힐러가 없는 다음 전장에서도 같은 교리가 버퍼를 타격한다.
 * ======================================================================== */
const DOCTRINE_SYSTEM = [
  '당신은 전술 오토배틀러의 "AI 사령관"이다. 방금 끝난 전투를 보고, 플레이어의 **의도**를 추론해',
  '영구적인 전술 교리(Doctrine)를 만든다.',
  '',
  '★ 가장 중요한 원칙: 교리는 "패턴"이 아니라 "원리"여야 한다.',
  '  ❌ "힐러를 먼저 공격한다"                          (유닛 이름 암기)',
  '  ⭕ "적 전력을 증폭하는 지원형이 있으면 먼저 제거한다"  (전장에 대한 술어)',
  '',
  '핵심 규칙:',
  '1) 명령을 그대로 저장하지 마라. 표면적 지시("힐러 먼저") 뒤의 의도("회복 차단")를 추론하라.',
  '   "쟤네 자꾸 살아나는데?" 같은 간접 표현에서도 의도를 읽어라.',
  '2) 반드시 **역할군(role)** 수준으로 일반화하라. 유닛 이름이 아니라 주어진 role 목록 중 하나를 골라라.',
  '   예) "힐러 먼저" → role="support" (힐러도 버퍼도 지원형 → 힐러가 없는 전장에서도 적용된다)',
  '3) requiresTrait: 이 교리가 발동할 조건이 되는 특성. 교리를 "원리"로 만드는 핵심이다.',
  '   예) 회복·강화 차단 의도 → requiresTrait="amplifier" (증폭형이 없는 전장에선 발동하지 않는다)',
  '4) ★ 예외 학습: 기존 교리를 적용했는데 **패배**했고, 그 원인이 특정 특성(backfireTraits)이라면,',
  '   교리를 버리지 말고 **예외**를 만들어라. exceptTrait에 그 특성을 넣고, role은 기존 교리와 같게 유지하라.',
  '   예) 자폭(volatile)하는 지원형 때문에 졌다면 → role="support", exceptTrait="volatile"',
  '   이것이 "일반화의 한계 인식"이다.',
  '5) ★ 없는 의도를 지어내지 마라. 플레이어 명령이 없고 발동한 교리도 없었다면, AI는 그냥',
  '   "가장 가까운 적"을 쳤을 뿐이다. 이때 제거 순서는 플레이어의 선택이 아니라 진형의 위치 때문이다.',
  '   (전사가 앞줄에 있으니 전사가 먼저 죽는다.) 그것을 "진형 붕괴 의도"로 해석하면 안 된다.',
  '   → 이 경우 반드시 role=null. 의도는 오직 **명령**에서 추론하고, 제거 순서는 근거 보강에만 써라.',
  '6) 새로 배울 것이 없거나 기존 교리와 완전히 중복이면 role을 null로 하라.',
  '   명령이 어떤 역할군을 **피하라는** 뜻("무시하고 지나가")이면 그 역할군을 role로 삼지 마라.',
  '7) reason에는 "무엇을 보고 그렇게 판단했는지"를 근거로 써라(명령 + 실제 제거 순서 + 승패).',
  '',
  '★ 출력 형식 (게임 화면에 그대로 렌더링되므로 반드시 지켜라):',
  'A) 말투 — 당신은 플레이어(사령관)에게 보고하는 참모다. **반드시 "~습니다/~합니다" 존댓말**을 써라.',
  '   ❌ "교훈을 얻었다", "패배했다"   ⭕ "교훈을 얻었습니다", "패배했습니다"',
  'B) 강조 — analysis와 reason에서 판단의 **핵심 어구 1~2개**를 `**...**`로 감싸라. 화면에서 강조 표시된다.',
  '   예) "이 선택의 의도를 **회복 차단**으로 판단했습니다."',
  '   name과 rule에는 `**`를 쓰지 마라(제목·규칙문에는 강조가 들어가지 않는다).',
  'C) 길이 — analysis는 1~2문장, reason은 1~2문장. 장황하면 화면을 넘친다.',
  'D) name — 8~20자의 짧은 제목. 예외 교리면 기존 이름 뒤에 " — 예외"를 붙여라(줄표는 —).',
  'E) rule — AI가 따를 규칙을 한 문장으로. 유닛 이름이 아니라 역할군·특성으로 서술하라.',
  '',
  'JSON만 출력한다.'
].join('\n');

// strict 스키마: 모든 필드 required + additionalProperties:false.
// role은 반드시 게임이 아는 역할군 중 하나(또는 배울 게 없으면 null)여야 한다.
// 이 enum이 "LLM이 게임 규칙 밖의 값을 지어내는 것"을 구조적으로 막는다.
function doctrineSchema(roleKeys, traitKeys) {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      analysis: { type: 'string' },
      doctrine: {
        type: 'object', additionalProperties: false,
        properties: {
          role: { type: ['string', 'null'], enum: roleKeys.concat([null]) },
          // 교리가 발동할 조건 — 이게 교리를 '원리'로 만든다
          requiresTrait: { type: ['string', 'null'], enum: traitKeys.concat([null]) },
          // 예외 — 이 특성을 가진 적에게는 교리를 적용하지 않는다
          exceptTrait: { type: ['string', 'null'], enum: traitKeys.concat([null]) },
          name: { type: 'string' }, rule: { type: 'string' },
          intent: { type: 'string' }, why: { type: 'string' }, reason: { type: 'string' }
        },
        required: ['role', 'requiresTrait', 'exceptTrait', 'name', 'rule', 'intent', 'why', 'reason']
      }
    },
    required: ['analysis', 'doctrine']
  };
}

function doctrinePrompt(ctx) {
  const b = ctx.battle || {};
  const lines = [
    '역할군 목록(반드시 이 중 하나를 role로 고를 것): ' + JSON.stringify(ctx.roles || []),
    '특성 목록(requiresTrait / exceptTrait에 사용): ' + JSON.stringify(ctx.traits || []),
    '스테이지: ' + (ctx.stage || ''),
    '플레이어 명령: "' + (ctx.command || '(명령 없음 — AI가 학습한 교리로 자율 전투)') + '"',
    '이번 전투의 적 구성(역할군): ' + JSON.stringify(b.enemyRoles || []),
    '플레이어가 제거한 순서(역할군): ' + JSON.stringify(b.killedRoles || []),
    '전투 결과: ' + (b.won ? '승리' : '패배'),
    '이번 전투에 발동한 교리 id: ' + (b.firedDoctrineId || '(없음)'),
    '이미 학습한 교리(신뢰도 포함): ' + JSON.stringify(ctx.existing || [])
  ];
  // ★ 예외 학습의 결정적 근거 — 교리를 적용했다가 역효과를 본 특성
  if ((b.backfireTraits || []).length) {
    lines.push('');
    lines.push('⚠ 역효과 관측: 발동한 교리에 따라 우선 타격한 대상이 ' +
      JSON.stringify(b.backfireTraits) + ' 특성을 가지고 있었고, 그 결과 아군이 큰 피해를 입었다.');
    lines.push('→ 교리를 폐기하지 말고 **예외**를 학습하라: role은 기존 교리와 같게 두고 exceptTrait을 설정하라.');
  }
  lines.push('');
  lines.push('위를 근거로 analysis(플레이어의 의도 또는 이번 전투의 교훈 1~2문장)와 doctrine을 생성하라.');
  lines.push('배울 것이 없거나 기존 교리와 완전히 중복이면 doctrine.role = null.');
  return lines.join('\n');
}

/* ---- OpenAI 어댑터 (structured outputs) ---------------------------------- */
async function callDoctrineOpenAI(ctx) {
  const roleKeys = (ctx.roles || []).map(function (r) { return r.key; });
  const traitKeys = (ctx.traits || []).map(function (t) { return t.key; });
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + OPENAI_KEY },
    body: JSON.stringify({
      model: MODEL, max_completion_tokens: guard.MAX_OUTPUT_TOKENS,
      messages: [
        { role: 'system', content: DOCTRINE_SYSTEM },
        { role: 'user', content: doctrinePrompt(ctx) }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'doctrine', strict: true, schema: doctrineSchema(roleKeys, traitKeys) }
      }
    })
  });
  if (!res.ok) throw new Error('openai ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  if (!msg || !msg.content) throw new Error('no content');
  return JSON.parse(msg.content);
}

/* ---- Anthropic 어댑터 (동일 계약) ---------------------------------------- */
async function callDoctrineAnthropic(ctx) {
  const roleKeys = (ctx.roles || []).map(function (r) { return r.key; });
  const traitKeys = (ctx.traits || []).map(function (t) { return t.key; });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL, max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: doctrineSchema(roleKeys, traitKeys) } },
      system: DOCTRINE_SYSTEM,
      messages: [{ role: 'user', content: doctrinePrompt(ctx) }]
    })
  });
  if (!res.ok) throw new Error('anthropic ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  const textBlock = (data.content || []).find(function (b2) { return b2.type === 'text'; });
  if (!textBlock) throw new Error('no text block');
  return JSON.parse(textBlock.text);
}

/** 프로바이더 디스패치. 프런트는 어느 쪽이 답했는지 알 필요가 없다. */
function callDoctrine(body) {
  const ctx = guard.doctrineCtx(body);
  if (PROVIDER === 'openai') return callDoctrineOpenAI(ctx);
  if (PROVIDER === 'anthropic') return callDoctrineAnthropic(ctx);
  return Promise.reject(new Error('no provider'));
}

function readJson(req, res, cb) {
  let body = '';
  req.on('data', function (c) {
    body += c;
    if (body.length > guard.MAX_BODY) { res.writeHead(413); res.end('too large'); req.destroy(); }
  });
  req.on('end', function () {
    if (res.headersSent) return;
    let ctx; try { ctx = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
    cb(ctx);
  });
}

const server = http.createServer(function (req, res) {
  // ---- API ----
  if (req.url === '/api/health') {
    res.writeHead(HAS_KEY ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: HAS_KEY,
      provider: HAS_KEY ? PROVIDER : null,          // 화면에 정직하게 표시된다
      model: HAS_KEY ? MODEL : null,
      backend: HAS_KEY ? PROVIDER : 'local'
    }));
    return;
  }
  if (req.url === '/api/intent' && req.method === 'POST') {
    if (!HAS_KEY) { res.writeHead(503); res.end('no key'); return; }
    if (!guard.allow(req.socket.remoteAddress)) { res.writeHead(429); res.end('rate limited'); return; }
    readJson(req, res, function (ctx) {
      callIntent(ctx).then(function (out) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      }).catch(function (err) {
        console.error('[intent] ' + err.message);   // 프런트는 정규식 폴백으로 자동 강등
        res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message }));
      });
    });
    return;
  }
  if (req.url === '/api/doctrine' && req.method === 'POST') {
    if (!HAS_KEY) { res.writeHead(503); res.end('no key'); return; }
    if (!guard.allow(req.socket.remoteAddress)) { res.writeHead(429); res.end('rate limited'); return; }
    readJson(req, res, function (ctx) {
      callDoctrine(ctx).then(function (out) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
      }).catch(function (err) {
        console.error('[doctrine] ' + err.message);   // 프런트는 로컬 엔진으로 자동 폴백
        res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message }));
      });
    });
    return;
  }
  if (req.url === '/api/advise' && req.method === 'POST') {
    if (!API_KEY) { res.writeHead(503); res.end('no key'); return; }
    let body = '';
    req.on('data', function (c) { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', function () {
      let ctx; try { ctx = JSON.parse(body || '{}'); } catch (e) { res.writeHead(400); res.end('bad json'); return; }
      callClaude(ctx).then(function (advice) {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(advice));
      }).catch(function (err) {
        console.error('[advise] ' + err.message);
        res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: err.message }));
      });
    });
    return;
  }

  // ---- 정적 파일 ----
  let rel = decodeURIComponent((req.url || '/').split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; } // 경로 이탈 방지
  fs.readFile(filePath, function (err, buf) {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
});

if (require.main === module) {
  server.listen(PORT, function () {
    console.log('지휘관 · COMMANDER  →  http://localhost:' + PORT);
    console.log(HAS_KEY
      ? '의도 추론 백엔드: ' + PROVIDER.toUpperCase() + ' (' + MODEL + ') 연동됨 ✓'
      : '의도 추론 백엔드: LOCAL (규칙 기반 폴백)\n'
        + '  → 실제 LLM 추론을 쓰려면: OPENAI_API_KEY=sk-... node server/proxy.js');
  });
}

module.exports = {
  health: function () {
    return {
      ok: HAS_KEY,
      provider: HAS_KEY ? PROVIDER : null,
      model: HAS_KEY ? MODEL : null,
      backend: HAS_KEY ? PROVIDER : 'local'
    };
  },
  callIntent: callIntent,
  callDoctrine: callDoctrine
};
