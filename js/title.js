/* =============================================================================
 * title.js — 타이틀 화면 앰비언트 애니메이션 + 로딩 시퀀스 + 게임 진입
 * ========================================================================== */
(function () {
  'use strict';
  var canvas = document.getElementById('titleCanvas');
  var ctx = canvas.getContext('2d');
  var W = 0, H = 0, dpr = 1, tokens = [], tracers = [], last = 0, running = true;

  function resize() {
    dpr = window.devicePixelRatio || 1;
    W = window.innerWidth; H = window.innerHeight;
    canvas.width = Math.floor(W * dpr); canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function seed() {
    tokens = [];
    var glyphs = ['⚔', '🏹', '✚', '⚔', '🏹'];
    for (var team = 0; team < 2; team++) {
      for (var i = 0; i < 5; i++) {
        tokens.push({
          team: team, glyph: glyphs[i],
          x: (team === 0 ? 0.12 + Math.random() * 0.3 : 0.58 + Math.random() * 0.3) * W,
          y: (0.15 + Math.random() * 0.7) * H,
          vx: (Math.random() - 0.5) * 22, vy: (Math.random() - 0.5) * 22
        });
      }
    }
  }

  function frame(ts) {
    if (!running) return;
    if (!last) last = ts;
    var dt = Math.min(0.05, (ts - last) / 1000); last = ts;
    render(dt);
    requestAnimationFrame(frame);
  }

  function render(dt) {
    ctx.clearRect(0, 0, W, H);
    // 격자
    ctx.strokeStyle = 'rgba(120,170,255,0.05)'; ctx.lineWidth = 1;
    for (var x = 0; x < W; x += 46) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
    for (var y = 0; y < H; y += 46) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

    // 토큰 이동
    var i, t;
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i]; t.x += t.vx * dt; t.y += t.vy * dt;
      if (t.x < 40 || t.x > W - 40) t.vx *= -1;
      if (t.y < 60 || t.y > H - 60) t.vy *= -1;
    }
    // 같은 팀 네트워크 선
    for (i = 0; i < tokens.length; i++) for (var j = i + 1; j < tokens.length; j++) {
      var a = tokens[i], b = tokens[j]; if (a.team !== b.team) continue;
      var d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < W * 0.22) {
        ctx.strokeStyle = (a.team === 0 ? 'rgba(70,177,255,' : 'rgba(255,84,104,') + (0.14 * (1 - d / (W * 0.22))) + ')';
        ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    // 간헐적 교전 트레이서
    if (Math.random() < 0.03) {
      var blue = tokens[Math.floor(Math.random() * 5)], red = tokens[5 + Math.floor(Math.random() * 5)];
      tracers.push({ a: blue, b: red, life: 0 });
    }
    for (i = tracers.length - 1; i >= 0; i--) {
      var tr = tracers[i]; tr.life += dt;
      if (tr.life > 0.35) { tracers.splice(i, 1); continue; }
      ctx.strokeStyle = 'rgba(255,182,74,' + (0.5 * (1 - tr.life / 0.35)) + ')';
      ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(tr.a.x, tr.a.y); ctx.lineTo(tr.b.x, tr.b.y); ctx.stroke();
    }
    // 토큰
    for (i = 0; i < tokens.length; i++) {
      t = tokens[i];
      var col = t.team === 0 ? '70,177,255' : '255,84,104';
      var g = ctx.createRadialGradient(t.x, t.y, 1, t.x, t.y, 22);
      g.addColorStop(0, 'rgba(' + col + ',0.5)'); g.addColorStop(1, 'rgba(' + col + ',0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(t.x, t.y, 22, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgb(' + col + ')'; ctx.beginPath(); ctx.arc(t.x, t.y, 11, 0, 7); ctx.fill();
      ctx.font = '12px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t.glyph, t.x, t.y + 1);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  // ---- 로딩 → 게임 진입 ----
  var FLAVORS = ['전술 네트워크 동기화…', '전장 지형 로딩…', 'AI 에이전트 초기화…',
    '지휘 콘솔 연결…', '부대 편성 배치…', '교전 규칙 컴파일…'];
  function launch() {
    var loading = document.getElementById('loading');
    var fill = document.getElementById('loadFill');
    var flavor = document.getElementById('loadFlavor');
    loading.classList.remove('hidden');
    var p = 0, fi = 0;
    flavor.textContent = FLAVORS[0];
    var iv = setInterval(function () {
      p += 8 + Math.random() * 16; if (p > 100) p = 100;
      fill.style.width = p + '%';
      if (Math.random() < 0.5) { fi = (fi + 1) % FLAVORS.length; flavor.textContent = FLAVORS[fi]; }
      if (p >= 100) {
        clearInterval(iv);
        flavor.textContent = '전투 준비 완료';
        setTimeout(enterGame, 350);
      }
    }, 140);
  }
  function enterGame() {
    running = false;
    document.getElementById('loading').classList.add('hidden');
    if (window.__revealStages) window.__revealStages();      // 스테이지 선택으로
    else { document.getElementById('titleScreen').classList.add('hidden');
      document.getElementById('gameScreen').classList.remove('hidden');
      if (window.__revealGame) window.__revealGame(); }
  }

  window.addEventListener('resize', function () { if (running) { resize(); } });
  document.getElementById('btnStart').addEventListener('click', launch);

  resize(); seed(); render(0);         // 첫 프레임 즉시 그리기(정지 상태에서도 보이도록)
  requestAnimationFrame(frame);
})();
