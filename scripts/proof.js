/* =============================================================================
 * proof.js — 이 게임이 주장하는 것을 회귀 테스트로 고정한다.
 *   ① 일반화  : "힐러 먼저" → 힐러 없는 전장에서 버퍼(같은 support)를 친다
 *   ② 조건부  : 증폭형이 없는 전장에서는 교리가 아예 발동하지 않는다 (원리 ≠ 암기)
 *   ③ 예외    : 교리를 적용했다 졌을 때, 규칙을 버리지 않고 예외를 배운다
 *   ④ 신뢰도  : 배울 게 없어도 null을 뱉지 않고 성적을 보고한다 (화면이 죽지 않음)
 * 실행: node scripts/proof.js   (DOM 없이 로컬 폴백 엔진으로 검증)
 * ========================================================================== */
const fs = require('fs');
const vm = require('vm');
const R = require('path').join(__dirname, '..') + '/';
const sandbox = { window: {}, console, fetch: () => Promise.reject(new Error('offline')), performance: { now: () => 0 } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['js/units.js', 'js/brain.js', 'js/doctrine.js'].forEach(f =>
  vm.runInContext(fs.readFileSync(R + f, 'utf8'), sandbox, { filename: f }));

const U = sandbox.window.CommanderUnits;
const Brain = sandbox.window.CommanderBrain;
const Doctrine = sandbox.window.Doctrine;
const A = U.ARCHETYPES;

function mk(key, x, y) { return { arch: A[key], x, y, hp: A[key].maxHp, maxHp: A[key].maxHp, alive: true }; }
let pass = 0, fail = 0;
const check = (name, cond) => { console.log((cond ? '  ✓ ' : '  ✗ ') + name); cond ? pass++ : fail++; };

const CMD = '적 힐러에게 화력을 집중해 먼저 처치해라';
let doctrines = [];

(async () => {
  // ─── ① STAGE 1: 명령 → 교리 ────────────────────────────────────────────
  console.log('\n[STAGE 1] 명령: "' + CMD + '"');
  const r1 = await Doctrine.analyze({
    command: CMD, stageName: '첫 교전',
    battle: { killedRoles: ['support', 'frontline'], enemyRoles: ['frontline', 'frontline', 'ranged', 'support'], won: true },
    existing: doctrines
  });
  console.log('  ANALYSIS: ' + r1.analysis.replace(/\*\*/g, ''));
  console.log('  DOCTRINE: ' + r1.doctrine.name + ' — ' + r1.doctrine.rule);
  check('kind=new', r1.kind === 'new');
  check('유닛 이름이 아니라 역할군으로 일반화', r1.doctrine.action.targetRole === 'support');
  check('★ 교리가 암기가 아니라 원리 — 조건(amplifier)을 가진다',
    !!r1.doctrine.condition && r1.doctrine.condition.requiresTrait === 'amplifier');
  check('교리 문장이 유닛 이름("힐러")으로 시작하지 않음', !/^힐러/.test(r1.doctrine.rule));
  r1.doctrine.status = 'accepted';
  doctrines.push(r1.doctrine);

  // ─── ② STAGE 3: 힐러 없음 · 버퍼 있음 · 명령 없음 ──────────────────────
  console.log('\n[STAGE 3] 적: 전사·전사·궁수·버퍼 (힐러 없음) / 명령: (없음)');
  const enemies3 = [mk('warrior', 600, 260), mk('warrior', 600, 340), mk('archer', 680, 300), mk('buffer', 730, 300)];
  const p3 = Brain.composePolicy([]);
  const fired3 = Doctrine.applyTo(p3, doctrines, enemies3);
  check('교리 조건 성립(버퍼=amplifier) → 발동', !!fired3 && p3.targetRole === 'support');
  const me = mk('archer', 300, 300);
  const t3 = U.chooseTarget(me, enemies3, p3, U.computeTeamFocus([me], enemies3, p3), 1e9);
  console.log('  → AI가 고른 표적: ' + t3.arch.label);
  check('★ 힐러가 없는데도 버퍼를 노린다 (일반화 증명)', t3.arch.key === 'buffer');

  // ─── ③ 조건 불성립: 증폭형이 아예 없는 전장 ────────────────────────────
  console.log('\n[조건 판정] 적: 전사·전사·궁수 (증폭형 없음)');
  const enemiesNo = [mk('warrior', 600, 260), mk('warrior', 600, 340), mk('archer', 680, 300)];
  const pNo = Brain.composePolicy([]);
  const firedNo = Doctrine.applyTo(pNo, doctrines, enemiesNo);
  check('★ 증폭형이 없으면 교리가 발동하지 않는다 (원리 ≠ 암기)', firedNo === null && pNo.targetRole === null);

  // ─── ④ STAGE 4: 폭탄 힐러 — 교리를 적용했다가 패배 ─────────────────────
  console.log('\n[STAGE 4] 적: 전사·전사·궁수·폭탄 힐러 / 명령: (없음)');
  const enemies4 = [mk('warrior', 600, 260), mk('warrior', 600, 340), mk('archer', 680, 300), mk('bomber', 730, 300)];
  const p4 = Brain.composePolicy([]);
  const fired4 = Doctrine.applyTo(p4, doctrines, enemies4);
  check('폭탄 힐러도 amplifier → 교리 발동', !!fired4);
  const t4 = U.chooseTarget(me, enemies4, p4, U.computeTeamFocus([me], enemies4, p4), 1e9);
  console.log('  → AI가 고른 표적: ' + t4.arch.label + ' (교리대로 지원형을 침 → 자폭 피격)');
  check('교리에 따라 폭탄 힐러를 우선 타격한다', t4.arch.key === 'bomber');

  // 전투 후: 교리를 적용했으나 패배 + volatile 역효과 관측
  const r4 = await Doctrine.analyze({
    command: '', stageName: '예외',
    battle: {
      killedRoles: ['support'], enemyRoles: ['frontline', 'frontline', 'ranged', 'support'], won: false,
      firedDoctrineId: fired4.id, backfireTraits: ['volatile']
    },
    existing: doctrines
  });
  console.log('\n  ANALYSIS: ' + r4.analysis.replace(/\*\*/g, ''));
  console.log('  EXCEPTION: ' + r4.doctrine.name + ' — ' + r4.doctrine.rule);
  check('kind=exception', r4.kind === 'exception');
  check('★ 규칙을 버리지 않는다 — 역할군은 그대로 support', r4.doctrine.action.targetRole === 'support');
  check('★ volatile에만 예외를 건다 (일반화의 한계 인식)', r4.doctrine.action.exceptTrait === 'volatile');
  r4.doctrine.status = 'accepted';
  doctrines = doctrines.filter(d => d.action.targetRole !== 'support');
  doctrines.push(r4.doctrine);

  // 예외 적용 후: 같은 전장에서 폭탄 힐러를 더 이상 우선하지 않는다
  const p4b = Brain.composePolicy([]);
  Doctrine.applyTo(p4b, doctrines, enemies4);
  const t4b = U.chooseTarget(me, enemies4, p4b, U.computeTeamFocus([me], enemies4, p4b), 1e9);
  console.log('  → 예외 학습 후 표적: ' + t4b.arch.label);
  check('★ 예외 적용 → 폭탄 힐러를 우선하지 않는다', t4b.arch.key !== 'bomber');

  // 예외는 일반 버퍼에는 영향이 없어야 한다 (과잉 일반화 금지)
  const p3b = Brain.composePolicy([]);
  Doctrine.applyTo(p3b, doctrines, enemies3);
  const t3b = U.chooseTarget(me, enemies3, p3b, U.computeTeamFocus([me], enemies3, p3b), 1e9);
  check('★ 예외가 과잉 일반화되지 않는다 — 버퍼는 여전히 최우선', t3b.arch.key === 'buffer');

  // ─── ⑤ 배울 게 없는 판 ────────────────────────────────────────────────
  console.log('\n[배울 게 없는 판]');
  const r5 = await Doctrine.analyze({
    command: CMD, stageName: '재확인',
    battle: { killedRoles: ['support'], enemyRoles: ['support'], won: true, firedDoctrineId: 'doc_support', backfireTraits: [] },
    existing: doctrines.map(d => Object.assign({}, d, { score: { uses: 4, wins: 3, losses: 1 } }))
  });
  console.log('  ' + r5.analysis.replace(/\*\*/g, ''));
  check('★ null이 아니라 신뢰도를 보고한다 (화면이 죽지 않음)', r5.kind === 'report' && !!r5.analysis);
  check('신뢰도 계산: 4회 중 3승 = 75%', r5.scores[0].confidence === 75);

  // ─── ⑥ 없는 의도를 지어내지 않는다 ────────────────────────────────────
  // 명령도 교리도 없으면 AI는 근접 타겟팅을 한다. 전사가 앞줄이라 전사가 먼저 죽는다.
  // 그건 플레이어의 '선택'이 아니라 '위치 물리'다 → 교리를 제안하면 안 된다.
  console.log('\n[명령 없음 · 교리 없음 — 죽은 순서는 그냥 진형 때문]');
  const r6 = await Doctrine.analyze({
    command: '', stageName: '예외',
    battle: { killedRoles: ['frontline', 'frontline', 'frontline', 'ranged'],
              enemyRoles: ['frontline', 'frontline', 'frontline', 'ranged', 'support'],
              won: true, firedDoctrineId: null, backfireTraits: [] },
    existing: []
  });
  console.log('  ' + r6.analysis.replace(/\*\*/g, ''));
  check('★ 없는 의도를 지어내지 않는다 (전열형 우선 제거를 제안하지 않음)',
    r6.kind === 'report' && !r6.doctrine);

  // 조사 처리 — 교리 이름/의도가 가변이므로 "제거을", "붕괴으로" 같은 오타가 나면 안 된다
  const all = [r1, r4].map(x => (x.doctrine ? x.doctrine.reason : '')).join(' ') + ' ' + r5.analysis;
  check('조사 오류 없음 (…을/를, …으로/로)', !/(거|괴|과|기|리)을 /.test(all) && !/(괴|과|아|어)으로/.test(all));

  // ─── ⑦ 교리가 여러 개일 때 — 아무거나 덮어쓰면 안 된다 ─────────────────
  // 교리들은 targetRole을 두고 충돌한다. AI는 이 전장에 맞는 것을 '선택'해야 한다.
  console.log('\n[교리 충돌] 증폭형 우선(조건부) + 전열형 우선(무조건) 을 모두 학습한 상태');
  const dSupport = { id:'doc_support', name:'증폭형 우선 제거', rule:'r', status:'accepted',
    condition:{requiresTrait:'amplifier'}, action:{targetRole:'support', focusFire:true, exceptTrait:null},
    score:{uses:3, wins:3, losses:0} };
  const dFront = { id:'doc_frontline', name:'전열형 우선 제거', rule:'r', status:'accepted',
    condition:null, action:{targetRole:'frontline', focusFire:true, exceptTrait:null},
    score:{uses:5, wins:5, losses:0} };   // 신뢰도가 더 높아도 구체성이 이겨야 한다
  const pC = Brain.composePolicy([]);
  const firedC = Doctrine.applyTo(pC, [dSupport, dFront], enemies4);
  console.log('  → 발동한 교리: ' + (firedC ? firedC.name : 'none'));
  check('★ 나중에 배운 교리가 앞의 것을 덮어쓰지 않는다', firedC.id === 'doc_support');
  check('★ 조건이 전장에 맞는 교리가 우선한다 (구체성 > 신뢰도)', pC.targetRole === 'support');

  // 순서를 뒤집어도 결과가 같아야 한다 (배열 순서에 의존하면 안 된다)
  const pC2 = Brain.composePolicy([]);
  const firedC2 = Doctrine.applyTo(pC2, [dFront, dSupport], enemies4);
  check('★ 학습 순서와 무관하게 같은 판단', firedC2.id === 'doc_support');

  // 증폭형이 없는 전장에서는 조건부 교리가 후보에서 빠지고, 무조건 교리가 발동해야 한다
  const pC3 = Brain.composePolicy([]);
  const firedC3 = Doctrine.applyTo(pC3, [dSupport, dFront], enemiesNo);
  console.log('  → 증폭형 없는 전장에서 발동한 교리: ' + (firedC3 ? firedC3.name : 'none'));
  check('★ 조건 불성립 시 다른 교리로 폴백', firedC3.id === 'doc_frontline' && pC3.targetRole === 'frontline');

  // ─── ⑧ 정규식 폴백의 한계 = LLM이 필요한 이유 ──────────────────────────
  // 폴백이 구어체까지 잡으면 "왜 LLM인가"의 답이 사라진다. 폴백은 게임 용어만 잡아야 한다.
  // (이 테스트가 실패하면 = 정규식에 데모 문장을 하드코딩했다는 뜻)
  console.log('\n[정규식 폴백의 한계 — 이게 LLM이 필요한 이유]');
  const 게임용어 = Doctrine.interpretSync('적 힐러에게 화력을 집중해 먼저 처치해라');
  const 구어체1 = Doctrine.interpretSync('쟤 하나 때문에 안 죽잖아');
  const 구어체2 = Doctrine.interpretSync('뒤에 깃발 든 애 거슬려');
  const 구어체3 = Doctrine.interpretSync('뒤부터 죽여');
  console.log('  "적 힐러에게 화력을 집중…" → ' + (게임용어.understood ? '이해 O' : '이해 X'));
  console.log('  "쟤 하나 때문에 안 죽잖아"  → ' + (구어체1.understood ? '이해 O' : '이해 X'));
  console.log('  "뒤에 깃발 든 애 거슬려"    → ' + (구어체2.understood ? '이해 O' : '이해 X'));
  console.log('  "뒤부터 죽여"              → ' + (구어체3.understood ? '이해 O' : '이해 X'));
  check('폴백은 게임 용어를 이해한다', 게임용어.understood && 게임용어.set.targetRole === 'support');
  check('★ 폴백은 구어체를 이해하지 못한다 (정규식에 데모 문장을 박아넣지 않았다)',
    !구어체1.understood && !구어체2.understood && !구어체3.understood);

  // ─── ⑨ 교리의 진화(계보)는 연출이 아니라 기록이어야 한다 ────────────────
  // 지어낸 추상화 단계를 넣으면(= 실제로 일어나지 않은 진화를 연출하면) 그게 "UI만 AI"다.
  console.log('\n[교리의 진화 — 실제로 기록된 단계만]');
  const lin1 = r1.doctrine.lineage;
  console.log(lin1.map(s => '  ' + s.label + ': ' + s.text).join('\n'));
  check('계보가 플레이어의 원문에서 시작한다', lin1[0].step === 'command' && lin1[0].text.indexOf(CMD) !== -1);
  check('★ 추상화 사다리: 원문 → 의도 → 원리', lin1.map(s => s.step).join('>') === 'command>intent>rule');

  const lin4 = r4.doctrine.lineage;
  check('★ 예외는 기존 계보 위에 쌓인다 (덮어쓰지 않는다)',
    lin4.length === lin1.length + 1 && lin4[lin4.length - 1].step === 'exception');
  check('예외를 배워도 원문의 출처가 보존된다', lin4[0].step === 'command');

  // ─── ⑩ 전투 중 규칙 추가가 교리를 지우면 안 된다 ────────────────────────
  // composePolicy가 스택으로 정책을 재구성할 때 targetRole을 옮기지 않으면,
  // 교리·해석이 심어둔 조준이 조용히 null이 되어 AI가 아무 적이나 친다.
  console.log('\n[전투 중 규칙 추가 — 교리가 증발하면 안 된다]');
  const fragRole = { set: { targetRole: 'support', focusFire: true }, rules: ['적 지원형 우선'], matched: 1, text: 'x' };
  const fragOther = Brain.parseFragment('공격적으로 몰아쳐라');   // targetRole 없는 규칙
  const composed = Brain.composePolicy([fragRole, fragOther]);
  console.log('  targetRole 조각 + 무관한 규칙 → targetRole=' + composed.targetRole);
  check('★ 규칙을 덧붙여도 targetRole이 보존된다', composed.targetRole === 'support');
  check('덧붙인 규칙도 반영된다 (aggression 상승)', composed.aggression > 0.7);

  console.log('\n' + (fail === 0 ? '✅ 증명 통과 (' + pass + '/' + (pass + fail) + ')' : '❌ 실패 ' + fail + '건'));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('ERROR', e); process.exit(1); });
