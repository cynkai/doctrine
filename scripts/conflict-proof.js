const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..') + '/';
const sandbox = {
  window: {},
  console,
  fetch: () => Promise.reject(new Error('offline')),
  performance: { now: () => 0 }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
['js/units.js', 'js/brain.js', 'js/doctrine.js'].forEach(file => {
  vm.runInContext(fs.readFileSync(root + file, 'utf8'), sandbox, { filename: file });
});

const Units = sandbox.window.CommanderUnits;
const Brain = sandbox.window.CommanderBrain;
const Doctrine = sandbox.window.Doctrine;
const Archetypes = Units.ARCHETYPES;
let passed = 0;
let failed = 0;

function check(name, condition) {
  console.log((condition ? '  ✓ ' : '  ✗ ') + name);
  if (condition) passed++;
  else failed++;
}

function policy() {
  return Brain.composePolicy([]);
}

function unit(key) {
  const arch = Archetypes[key];
  return { arch, x: 0, y: 0, hp: arch.maxHp, maxHp: arch.maxHp, alive: true };
}

function doctrine(id, role, options) {
  const opts = options || {};
  return {
    id,
    name: id,
    status: opts.status || 'accepted',
    condition: opts.trait ? { requiresTrait: opts.trait } : null,
    action: {
      targetRole: role,
      focusFire: opts.focusFire !== false,
      exceptTrait: opts.exceptTrait || null
    },
    score: opts.score || { uses: 0, wins: 0, losses: 0 }
  };
}

function gameSandbox(doctrines, resolutions) {
  const storage = {
    commander_doctrines: JSON.stringify(doctrines),
    commander_doctrine_conflicts_v1: JSON.stringify({ version: 1, resolutions: resolutions || {} })
  };
  const game = {
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
  game.globalThis = game;
  vm.createContext(game);
  ['js/units.js', 'js/brain.js', 'js/doctrine.js', 'js/game.js'].forEach(file => {
    vm.runInContext(fs.readFileSync(root + file, 'utf8'), game, { filename: file });
  });
  return game.window.Commander;
}

console.log('\n[Shadow Conflict + Explicit Resolution]');

const emptyLegacyPolicy = policy();
const emptyDetailedPolicy = policy();
const emptyLegacy = Doctrine.applyTo(emptyLegacyPolicy, [], []);
const emptyDetailed = Doctrine.applyToDetailed(emptyDetailedPolicy, [], [], {});
check('Doctrine 0개: 두 API 모두 null', emptyLegacy === null && emptyDetailed.doctrine === null && emptyDetailed.conflict === null);
check('Doctrine 0개: 정책이 동일', JSON.stringify(emptyLegacyPolicy) === JSON.stringify(emptyDetailedPolicy));

const only = doctrine('doc_support', 'support');
const oneLegacyPolicy = policy();
const oneDetailedPolicy = policy();
const oneLegacy = Doctrine.applyTo(oneLegacyPolicy, [only], []);
const oneDetailed = Doctrine.applyToDetailed(oneDetailedPolicy, [only], [], {});
check('Doctrine 1개: 같은 Doctrine 선택', oneLegacy === only && oneDetailed.doctrine === only && oneDetailed.conflict === null);
check('Doctrine 1개: 정책이 동일', JSON.stringify(oneLegacyPolicy) === JSON.stringify(oneDetailedPolicy));

const conditional = doctrine('doc_support', 'support', { trait: 'amplifier', score: { uses: 1, wins: 0, losses: 1 } });
const unconditional = doctrine('doc_frontline', 'frontline', { score: { uses: 5, wins: 5, losses: 0 } });
const amplifierField = [unit('buffer'), unit('warrior')];
const specificLegacy = Doctrine.applyTo(policy(), [unconditional, conditional], amplifierField);
const specificDetailed = Doctrine.applyToDetailed(policy(), [unconditional, conditional], amplifierField, {});
check('조건부 vs 무조건: v1과 같은 조건부 선택', specificLegacy === conditional && specificDetailed.doctrine === conditional);
check('조건부 vs 무조건: 명확한 승자는 Conflict 없음', specificDetailed.conflict === null);

const lower = doctrine('doc_ranged', 'ranged', { score: { uses: 4, wins: 2, losses: 2 } });
const higher = doctrine('doc_elite', 'elite', { score: { uses: 4, wins: 3, losses: 1 } });
const confidenceLegacy = Doctrine.applyTo(policy(), [lower, higher], []);
const confidenceDetailed = Doctrine.applyToDetailed(policy(), [lower, higher], [], {});
check('서로 다른 신뢰도: v1과 같은 높은 신뢰도 선택', confidenceLegacy === higher && confidenceDetailed.doctrine === higher);
check('서로 다른 신뢰도: Conflict 없음', confidenceDetailed.conflict === null);

const first = doctrine('doc_support', 'support', { score: { uses: 2, wins: 1, losses: 1 } });
const second = doctrine('doc_ranged', 'ranged', { score: { uses: 4, wins: 2, losses: 2 } });
const tieLegacyPolicy = policy();
const tieLegacy = Doctrine.applyTo(tieLegacyPolicy, [first, second], []);
check('동률 applyTo: Memory 배열의 첫 Doctrine 선택', tieLegacy === first && tieLegacyPolicy.targetRole === 'support');

const tiePolicy = policy();
const tieDetailed = Doctrine.applyToDetailed(tiePolicy, [first, second], [], {});
check('동률 applyToDetailed: Conflict 반환', !!tieDetailed.conflict && tieDetailed.conflict.key === 'doc_ranged|doc_support');
check('resolution 없음: legacy winner 선택', tieDetailed.doctrine === first && tieDetailed.conflict.legacyWinnerId === first.id);
check('Conflict 후보는 현재 동률 후보', tieDetailed.conflict.contenderIds.join('|') === 'doc_support|doc_ranged');

const resolutions = { 'doc_ranged|doc_support': { winnerId: 'doc_ranged' } };
const resolvedPolicy = policy();
const resolved = Doctrine.applyToDetailed(resolvedPolicy, [first, second], [], resolutions);
check('resolution 존재: 지정 winner 선택', resolved.doctrine === second && resolvedPolicy.targetRole === 'ranged');
check('resolution 결과를 Conflict에 표시', resolved.conflict.resolvedWinnerId === second.id);
check('resolution 적용 전후 정책 결과가 다름', tiePolicy.targetRole === 'support' && resolvedPolicy.targetRole === 'ranged');

const nowHigher = doctrine('doc_ranged', 'ranged', { score: { uses: 4, wins: 3, losses: 1 } });
const brokenTie = Doctrine.applyToDetailed(policy(), [first, nowHigher], [], {
  'doc_ranged|doc_support': { winnerId: 'doc_support' }
});
check('동률이 깨지면 resolution 무시', brokenTie.doctrine === nowHigher && brokenTie.conflict === null);

const missingWinner = Doctrine.applyToDetailed(policy(), [first, second], [], {
  'doc_ranged|doc_support': { winnerId: 'doc_deleted' }
});
check('삭제된 winnerId: legacy winner로 fallback', missingWinner.doctrine === first && missingWinner.conflict.resolvedWinnerId === null);

const sameAction = doctrine('doc_support_copy', 'support', { score: { uses: 4, wins: 2, losses: 2 } });
const noBehaviorConflict = Doctrine.applyToDetailed(policy(), [first, sameAction], [], {});
check('실행 결과가 같으면 Conflict 없음', noBehaviorConflict.doctrine === first && noBehaviorConflict.conflict === null);

const rejected = doctrine('doc_rejected', 'elite', { status: 'proposed', score: { uses: 2, wins: 1, losses: 1 } });
const approvedOnly = Doctrine.applyToDetailed(policy(), [rejected, first, second], [], {});
check('승인되지 않은 Doctrine은 후보에서 제외', approvedOnly.conflict.contenderIds.indexOf('doc_rejected') === -1);

console.log('\n[Game Intent Override Attribution]');

const gameRanged = doctrine('doc_ranged', 'ranged');
const gameFrontline = doctrine('doc_frontline', 'frontline');
const explicitOnly = gameSandbox([gameRanged], {});
explicitOnly.simulate('힐러 먼저 공격해', 0);
check('Conflict 없음 + 명시적 Intent: 기존처럼 Intent가 지휘',
  explicitOnly.state().effPolicy.targetRole === 'support' && explicitOnly.state().doctrineConflict === null);

const unresolvedGame = gameSandbox([gameRanged, gameFrontline], {});
unresolvedGame.simulate('', 0);
check('Conflict 있음 + 명령 없음: Conflict와 선택 Doctrine 유지',
  !!unresolvedGame.state().doctrineConflict && unresolvedGame.state().firedDoctrine.id === 'doc_ranged'
    && unresolvedGame.state().effPolicy.targetRole === 'ranged');

const gameResolution = { 'doc_frontline|doc_ranged': { winnerId: 'doc_frontline' } };
const resolvedGame = gameSandbox([gameRanged, gameFrontline], gameResolution);
resolvedGame.simulate('힐러 먼저 공격해', 0);
check('Conflict resolution + 명시적 Intent: 현재 전투 Conflict 귀속 제거',
  resolvedGame.state().doctrineConflict === null && resolvedGame.state().firedDoctrine === null
    && resolvedGame.state().effPolicy.targetRole === 'support');
resolvedGame.simulate('', 0);
check('다음 무명령 전투: 저장된 Conflict resolution 재적용',
  resolvedGame.state().doctrineConflict.resolvedWinnerId === 'doc_frontline'
    && resolvedGame.state().firedDoctrine.id === 'doc_frontline'
    && resolvedGame.state().effPolicy.targetRole === 'frontline');

console.log('\n' + (failed === 0
  ? '✅ Conflict 증명 통과 (' + passed + '/' + (passed + failed) + ')'
  : '❌ Conflict 증명 실패 ' + failed + '건'));
process.exit(failed ? 1 : 0);
