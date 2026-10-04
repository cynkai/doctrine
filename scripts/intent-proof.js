// intent-proof.js — LLM 의도 응답이 게임 정책으로 바뀌는 경로 (v1.1.0)
//   1) "무시하고 지나가" — 피할 역할군(avoidRole → targetAvoid)
//   2) 비율 단위 — LLM이 퍼센트(60)로 내도 0.6으로 읽는다
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..') + '/';
let passed = 0;
let failed = 0;

function check(name, condition) {
  console.log((condition ? '  ✓ ' : '  ✗ ') + name);
  if (condition) passed++;
  else failed++;
}

function sandbox(storage) {
  storage = storage || {};
  const sb = {
    window: { addEventListener: () => {} },
    document: { getElementById: () => null },
    console,
    fetch: () => Promise.reject(new Error('offline')),
    performance: { now: () => 0 },
    localStorage: {
      getItem: key => storage[key] || null,
      setItem: (key, value) => { storage[key] = value; },
      removeItem: key => { delete storage[key]; }
    }
  };
  sb.globalThis = sb;
  vm.createContext(sb);
  return sb;
}

function load(sb, files) {
  files.forEach(file => vm.runInContext(fs.readFileSync(root + file, 'utf8'), sb, { filename: file }));
  return sb.window;
}

const w = load(sandbox(), ['js/units.js', 'js/brain.js', 'js/doctrine.js']);
const U = w.CommanderUnits;
const Brain = w.CommanderBrain;
const Doctrine = w.Doctrine;

function llm(extra) {
  return Object.assign({ understood: true, targetRole: null, exceptTrait: null, avoidRole: null,
    focusFire: false, kite: false, aggression: null, retreatHpPct: null, why: '', rules: [] }, extra);
}

function unit(key, x) {
  const arch = U.ARCHETYPES[key];
  return { arch, x: x, y: 0, hp: arch.maxHp, maxHp: arch.maxHp, alive: true };
}

console.log('\n[비율 단위 — 퍼센트로 와도 0~1로 읽는다]');
check('retreatHpPct 60 → 0.6', Doctrine.intentFromLLM(llm({ retreatHpPct: 60 })).set.retreatHpPct === 0.6);
check('retreatHpPct 0.35 → 그대로', Doctrine.intentFromLLM(llm({ retreatHpPct: 0.35 })).set.retreatHpPct === 0.35);
check('aggression 80 → 0.8', Doctrine.intentFromLLM(llm({ aggression: 80 })).set.aggression === 0.8);
check('범위 밖(250, -3)은 0~1로 자른다',
  Doctrine.intentFromLLM(llm({ retreatHpPct: 250 })).set.retreatHpPct === 1
    && Doctrine.intentFromLLM(llm({ aggression: -3 })).set.aggression === 0);
check('1은 100%가 아니라 1 그대로', Doctrine.intentFromLLM(llm({ aggression: 1 })).set.aggression === 1);

console.log('\n[피할 역할군 — avoidRole → targetAvoid]');
check('avoidRole=frontline → targetAvoid', Doctrine.intentFromLLM(llm({ avoidRole: 'frontline' })).set.targetAvoid === 'frontline');
check('targetRole과 같으면 버린다',
  Doctrine.intentFromLLM(llm({ targetRole: 'support', avoidRole: 'support' })).set.targetAvoid === undefined);
check('게임이 모르는 역할군은 버린다', Doctrine.intentFromLLM(llm({ avoidRole: 'dragon' })).set.targetAvoid === undefined);
check('규칙 스택을 다시 쌓아도 targetAvoid가 남는다',
  Brain.composePolicy([{ set: { targetAvoid: 'frontline' }, rules: [], matched: 1 },
    { set: { aggression: 0.8 }, rules: [], matched: 1 }]).targetAvoid === 'frontline');

console.log('\n[타겟 선택 — 피할 역할군은 다른 적이 있는 동안 치지 않는다]');
const self = unit('warrior', 0);
const shield = unit('warrior', 30);     // 가까운 전열형
const archer = unit('archer', 120);     // 조금 먼 원거리형
const avoidPolicy = Object.assign(Brain.composePolicy([]), { targetAvoid: 'frontline' });
check('기본 정책: 가장 가까운 전열형', U.chooseTarget(self, [shield, archer], Brain.composePolicy([]), null, 1e9) === shield);
check('targetAvoid=frontline: 원거리형으로 지나간다', U.chooseTarget(self, [shield, archer], avoidPolicy, null, 1e9) === archer);
check('전열형만 남으면 그대로 싸운다', U.chooseTarget(self, [shield], avoidPolicy, null, 1e9) === shield);
const allies = [unit('warrior', 0), unit('archer', 10)];
check('화력 집중 대상에서도 빠진다', U.computeTeamFocus(allies, [shield, archer], avoidPolicy) === archer);

console.log('\n[전투 — 명령이 피하라는 역할군을 교리가 노리면 명령이 이긴다]');
const frontDoctrine = {
  id: 'doc_frontline', name: '전열 우선', status: 'accepted', condition: null,
  action: { targetRole: 'frontline', focusFire: true, exceptTrait: null },
  score: { uses: 3, wins: 3, losses: 0 }
};
const gw = load(sandbox({ commander_doctrines: JSON.stringify([frontDoctrine]) }),
  ['js/units.js', 'js/brain.js', 'js/doctrine.js', 'js/game.js']);
const game = gw.Commander;
game.simulate('', 0);
const baseline = game.state().killedRoles.slice();
check('명령 없음: 전열 교리가 발동한다',
  game.state().firedDoctrine && game.state().firedDoctrine.id === 'doc_frontline'
    && game.state().effPolicy.targetRole === 'frontline');
// LLM이 "방패 든 애는 무시하고 지나가"를 avoidRole=frontline으로 읽었다고 둔다
gw.Doctrine.interpretSync = () => Doctrine.intentFromLLM(llm({ avoidRole: 'frontline', rules: ['전열형은 건너뜀'] }));
game.simulate('앞에 방패 든 애는 무시하고 지나가', 0);
const st = game.state();
check('교리의 전열 타격이 꺼진다', st.effPolicy.targetRole === null && st.firedDoctrine === null);
check('targetAvoid가 이번 전투 정책에 실린다', st.effPolicy.targetAvoid === 'frontline');
check('교리만 있을 때는 전열형이 먼저 쓰러진다 (' + baseline.join('→') + ')', baseline[0] === 'frontline');
check('명령 후에는 다른 역할군이 먼저 쓰러진다 (' + st.killedRoles.join('→') + ')',
  st.killedRoles.length > 0 && st.killedRoles[0] !== 'frontline');

console.log('\n' + (failed === 0
  ? '✅ 의도 증명 통과 (' + passed + '/' + (passed + failed) + ')'
  : '❌ 의도 증명 실패 ' + failed + '건'));
process.exit(failed ? 1 : 0);
