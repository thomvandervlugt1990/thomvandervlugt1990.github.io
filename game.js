// Flappy Thom: a small Flappy Bird-style game on a canvas, styled as an
// 80s arcade / synthwave / 8-bit game.
// Game logic runs on a fixed logical size (400x600); CSS scales the canvas.
// The scene is drawn to a small offscreen canvas (half size) and scaled up
// with smoothing off, which gives the chunky pixel look.

(function () {
  'use strict';

  // ---- Setup ----------------------------------------------------------

  var canvas = document.getElementById('game-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var W = 400;            // logical width
  var H = 600;            // logical height
  var GROUND_H = 80;
  var GROUND_Y = H - GROUND_H;
  var PIX = 2;            // logical pixels per "retro pixel"

  // Make the canvas crisp on high-DPI screens
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;   // chunky pixels when scaling up

  // Low-res offscreen canvas: all drawing happens here, in logical
  // coordinates (the 1/PIX transform shrinks it to 200x300 real pixels).
  var off = makeCanvas(W / PIX, H / PIX);
  var o = off.getContext('2d');
  o.setTransform(1 / PIX, 0, 0, 1 / PIX, 0, 0);
  o.imageSmoothingEnabled = false;

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  // Snap a logical coordinate to the retro pixel grid
  function sn(v) { return Math.round(v / PIX) * PIX; }

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* matchMedia unavailable: ignore */ }

  // ---- Tuning (units: logical pixels and seconds) ---------------------

  var GRAVITY = 1500;        // px/s^2
  var FLAP_SPEED = -450;     // px/s, upward impulse
  var MAX_FALL = 700;        // terminal velocity
  var PIPE_SPEED = 150;      // px/s
  var PIPE_W = 64;
  var PIPE_GAP = 155;
  var PIPE_SPACING = 230;    // distance between pipe starts
  var GAP_MARGIN = 70;       // min distance from gap to ceiling / ground
  var BIRD_X = 110;
  var BIRD_R = 28;           // face diameter 56px (big, so it survives pixelation)
  var HIT_R = BIRD_R - 6;    // slightly forgiving hitbox
  var RESTART_DELAY = 0.5;   // seconds before game over can be dismissed
  var SHAKE_TIME = 0.4;      // screen shake after a crash
  var FLASH_TIME = 0.18;     // single short flash after a crash
  var FLASH_ALPHA = 0.35;    // max flash opacity (kept low on purpose)
  var GRID = 50;             // spacing of the vertical floor lines

  // ---- Look: palette and fonts ----------------------------------------

  var FONT = '"Press Start 2P", monospace';   // falls back to monospace by itself
  var CYAN = '#25f4ee';
  var MAGENTA = '#ff2bd6';
  var DARK = '#12002b';

  // ---- State ----------------------------------------------------------

  var state = 'ready';       // 'ready' | 'playing' | 'over'
  var bird, pipes, score, best, flapBoost, wingPhase, scroll, overTime;
  var time = 0;              // total running time, drives blinking / twinkling
  var scorePop = 0;          // 1 -> 0 after scoring, scales the score text
  var shakeT = 0;
  var flashT = 0;
  var newBest = false;
  var trailT = 0;
  var pipeId = 0;
  var particles = [];

  // Face image, with a yellow circle as fallback
  var face = new Image();
  var faceLoaded = false;
  face.onload = function () { faceLoaded = true; };
  face.onerror = function () { faceLoaded = false; };
  face.src = 'images/thom-face.png';

  best = loadBest();
  reset();

  function reset() {
    bird = { y: H / 2 - 40, vy: 0 };
    pipes = [];
    particles = [];
    score = 0;
    flapBoost = 0;
    wingPhase = 0;
    scroll = 0;
    overTime = 0;
    scorePop = 0;
    shakeT = 0;
    flashT = 0;
    newBest = false;
    state = 'ready';
  }

  // ---- Best score and mute storage ------------------------------------

  function loadBest() {
    try {
      return parseInt(localStorage.getItem('flappyThomBest'), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function saveBest() {
    try {
      localStorage.setItem('flappyThomBest', String(best));
    } catch (e) { /* storage unavailable: ignore */ }
  }

  function loadMuted() {
    try {
      return localStorage.getItem('flappyThomMuted') === '1';
    } catch (e) {
      return false;   // default: sound on
    }
  }

  function saveMuted() {
    try {
      localStorage.setItem('flappyThomMuted', muted ? '1' : '0');
    } catch (e) { /* storage unavailable: ignore */ }
  }

  // ---- Sound (8-bit chiptune via WebAudio, no audio files) ------------

  var muted = loadMuted();
  var audio = null;          // created on the first user gesture
  var noiseBuffer = null;
  var muteBtn = document.getElementById('sound-toggle');

  function updateMuteButton() {
    if (!muteBtn) return;
    muteBtn.textContent = muted ? 'Sound: off' : 'Sound: on';
    muteBtn.setAttribute('aria-pressed', muted ? 'false' : 'true');
  }

  // Must be called from a user gesture (tap / key) the first time
  function unlockAudio() {
    if (!audio) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        audio = new AC();
      } catch (e) {
        audio = null;
        return;
      }
    }
    if (audio.state === 'suspended') audio.resume();
  }

  // One square-wave blip that slides from f0 to f1
  function tone(f0, f1, dur, vol, delay) {
    if (muted || !audio) return;
    var t = audio.currentTime + (delay || 0);
    var osc = audio.createOscillator();
    var gain = audio.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.linearRampToValueAtTime(f1, t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain);
    gain.connect(audio.destination);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  // Short burst of noise for the crash
  function noise(dur, vol) {
    if (muted || !audio) return;
    if (!noiseBuffer) {
      var len = Math.floor(audio.sampleRate * 0.5);
      noiseBuffer = audio.createBuffer(1, len, audio.sampleRate);
      var data = noiseBuffer.getChannelData(0);
      for (var i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    var t = audio.currentTime;
    var src = audio.createBufferSource();
    var gain = audio.createGain();
    src.buffer = noiseBuffer;
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(gain);
    gain.connect(audio.destination);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  function sfxFlap() { tone(330, 700, 0.09, 0.07); }
  function sfxPoint() { tone(988, 988, 0.07, 0.07); tone(1319, 1319, 0.12, 0.07, 0.07); }
  function sfxCrash() { noise(0.35, 0.18); tone(220, 40, 0.4, 0.09); }

  function toggleMute() {
    muted = !muted;
    saveMuted();
    updateMuteButton();
    if (!muted) { unlockAudio(); sfxFlap(); }
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', function () {
      toggleMute();
      muteBtn.blur();     // so Space keeps flapping instead of pressing the button
    });
  }
  updateMuteButton();

  // ---- Input ----------------------------------------------------------

  function flap() {
    unlockAudio();
    if (state === 'ready') {
      state = 'playing';
      spawnPipe(W + 60);
    } else if (state === 'over') {
      if (overTime < RESTART_DELAY) return;
      reset();
      return;
    }
    bird.vy = FLAP_SPEED;
    flapBoost = 1;
    sfxFlap();
    flapParticles();
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    flap();
  });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();       // keep the page from scrolling
      if (!e.repeat) flap();
    } else if (e.code === 'KeyM' && !e.repeat) {
      toggleMute();
    }
  });

  // ---- Particles ------------------------------------------------------

  var PARTICLE_COLORS = [CYAN, MAGENTA, '#ffffff', '#ffe94d'];

  function addParticle(x, y, vx, vy, life, color) {
    if (particles.length > 150) return;
    particles.push({ x: x, y: y, vx: vx, vy: vy, life: life, max: life, color: color });
  }

  // Small burst behind the bird on every flap
  function flapParticles() {
    for (var i = 0; i < 8; i++) {
      addParticle(BIRD_X - 18, bird.y + 12, -60 - Math.random() * 100, (Math.random() - 0.3) * 140,
        0.35 + Math.random() * 0.25, PARTICLE_COLORS[i % PARTICLE_COLORS.length]);
    }
  }

  // Bigger explosion on a crash
  function crashParticles() {
    for (var i = 0; i < 28; i++) {
      var a = Math.random() * Math.PI * 2;
      var s = 80 + Math.random() * 220;
      addParticle(BIRD_X, bird.y, Math.cos(a) * s, Math.sin(a) * s,
        0.5 + Math.random() * 0.5, PARTICLE_COLORS[i % PARTICLE_COLORS.length]);
    }
  }

  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
  }

  // ---- Pipes ----------------------------------------------------------

  function spawnPipe(x) {
    var min = GAP_MARGIN + PIPE_GAP / 2;
    var max = GROUND_Y - GAP_MARGIN - PIPE_GAP / 2;
    pipes.push({
      x: x,
      gapY: min + Math.random() * (max - min),  // centre of the gap
      passed: false,
      id: pipeId++
    });
  }

  // ---- Update ---------------------------------------------------------

  function update(dt) {
    time += dt;
    flapBoost = Math.max(0, flapBoost - dt * 3);
    scorePop = Math.max(0, scorePop - dt * 4);
    shakeT = Math.max(0, shakeT - dt);
    flashT = Math.max(0, flashT - dt);
    updateParticles(dt);

    if (state === 'ready') {
      // Gentle bobbing while waiting
      wingPhase += dt * 6;
      bird.y = H / 2 - 40 + Math.sin(time * 4) * 8;
      scroll += PIPE_SPEED * dt;
      return;
    }

    if (state === 'over') {
      overTime += dt;
      // Let the bird drop to the ground after crashing
      if (bird.y + BIRD_R < GROUND_Y) {
        bird.vy = Math.min(bird.vy + GRAVITY * dt, MAX_FALL);
        bird.y = Math.min(bird.y + bird.vy * dt, GROUND_Y - BIRD_R);
      }
      return;
    }

    wingPhase += dt * (6 + flapBoost * 14);   // faster flapping right after a tap

    // Bird physics
    bird.vy = Math.min(bird.vy + GRAVITY * dt, MAX_FALL);
    bird.y += bird.vy * dt;

    // Sparkly trail
    trailT -= dt;
    if (trailT <= 0) {
      trailT = 0.05;
      addParticle(BIRD_X - 24, bird.y + (Math.random() - 0.5) * 16, -50, 0, 0.3,
        Math.random() < 0.5 ? CYAN : MAGENTA);
    }

    // Move pipes and spawn new ones at an even distance
    for (var i = 0; i < pipes.length; i++) pipes[i].x -= PIPE_SPEED * dt;
    var last = pipes[pipes.length - 1];
    if (!last || last.x <= W + 60 - PIPE_SPACING) spawnPipe(last ? last.x + PIPE_SPACING : W + 60);
    if (pipes[0].x + PIPE_W < -10) pipes.shift();

    scroll += PIPE_SPEED * dt;

    // Score: bird centre passed the pipe's right edge
    pipes.forEach(function (p) {
      if (!p.passed && p.x + PIPE_W < BIRD_X) {
        p.passed = true;
        score++;
        scorePop = 1;
        sfxPoint();
      }
    });

    // Collisions: ceiling, ground, pipes
    var hit = bird.y - HIT_R < 0 || bird.y + HIT_R > GROUND_Y;
    pipes.forEach(function (p) {
      var topH = p.gapY - PIPE_GAP / 2;
      var botY = p.gapY + PIPE_GAP / 2;
      if (circleHitsRect(BIRD_X, bird.y, HIT_R, p.x, 0, PIPE_W, topH) ||
          circleHitsRect(BIRD_X, bird.y, HIT_R, p.x, botY, PIPE_W, GROUND_Y - botY)) {
        hit = true;
      }
    });

    if (hit) {
      bird.y = Math.max(bird.y, HIT_R);
      bird.y = Math.min(bird.y, GROUND_Y - BIRD_R);
      state = 'over';
      overTime = 0;
      if (score > best) {
        best = score;
        newBest = true;
        saveBest();
      }
      // Crash juice
      if (!reduceMotion) {
        shakeT = SHAKE_TIME;
        flashT = FLASH_TIME;
      }
      crashParticles();
      sfxCrash();
    }
  }

  function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
    var nx = Math.max(rx, Math.min(cx, rx + rw));
    var ny = Math.max(ry, Math.min(cy, ry + rh));
    var dx = cx - nx;
    var dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  // ---- Pre-rendered backgrounds (built once, drawn every frame) -------

  function lerp(a, b, t) { return a + (b - a) * t; }

  // Colour from a list of [position, r, g, b] stops
  function gradientColor(stops, t) {
    for (var i = 1; i < stops.length; i++) {
      if (t <= stops[i][0] || i === stops.length - 1) {
        var a = stops[i - 1];
        var b = stops[i];
        var k = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
        return 'rgb(' + Math.round(lerp(a[1], b[1], k)) + ',' +
          Math.round(lerp(a[2], b[2], k)) + ',' + Math.round(lerp(a[3], b[3], k)) + ')';
      }
    }
    return '#000';
  }

  // Sky in hard colour bands (no smooth gradient: that is the 8-bit look),
  // plus the striped retro sun sitting on the horizon.
  function buildBackground() {
    var c = makeCanvas(W / PIX, H / PIX);
    var g = c.getContext('2d');
    g.setTransform(1 / PIX, 0, 0, 1 / PIX, 0, 0);
    g.imageSmoothingEnabled = false;

    var sky = [
      [0.0, 11, 2, 33],       // deep purple
      [0.45, 42, 10, 94],
      [0.75, 161, 22, 122],   // magenta
      [1.0, 255, 122, 61]     // orange at the horizon
    ];
    var band = 8;
    for (var y = 0; y < GROUND_Y; y += band) {
      g.fillStyle = gradientColor(sky, y / GROUND_Y);
      g.fillRect(0, y, W, band);
    }

    // Soft glow rings around the sun
    var cx = W / 2;
    var cy = GROUND_Y - 60;
    var r = 84;
    g.save();
    g.beginPath();
    g.rect(0, 0, W, GROUND_Y);
    g.clip();
    for (var i = 3; i >= 1; i--) {
      g.fillStyle = 'rgba(255, 60, 160, 0.10)';
      g.beginPath();
      g.arc(cx, cy, r + i * 16, 0, Math.PI * 2);
      g.fill();
    }

    // The sun: horizontal rows, yellow at the top to magenta at the bottom,
    // with stripes that get thicker toward the bottom
    var sun = [[0, 255, 233, 77], [0.5, 255, 140, 60], [1, 255, 43, 138]];
    for (var sy = cy - r; sy < cy + r; sy += PIX) {
      var dy = sy + PIX / 2 - cy;
      var t = (sy - (cy - r)) / (2 * r);
      if (dy > 0) {
        var gap = (dy / r) * 12;
        if ((dy % 18) < gap) continue;
      }
      var half = Math.sqrt(Math.max(0, r * r - dy * dy));
      g.fillStyle = gradientColor(sun, t);
      g.fillRect(sn(cx - half), sy, sn(half * 2), PIX);
    }
    g.restore();
    return c;
  }

  // A tileable strip of city skyline (buildings with lit windows)
  function buildSkyline(minH, maxH, fill, edge, seed) {
    var c = makeCanvas(W / PIX, GROUND_Y / PIX);
    var g = c.getContext('2d');
    g.setTransform(1 / PIX, 0, 0, 1 / PIX, 0, 0);
    g.imageSmoothingEnabled = false;

    // Small deterministic random so the city looks the same on each load
    var s = seed;
    function rnd() {
      s = (s * 16807) % 2147483647;
      return s / 2147483647;
    }

    var winColors = ['#ff9de2', '#ffe94d', CYAN];
    var x = 0;
    while (x < W) {
      var bw = sn(24 + rnd() * 36);
      if (x + bw > W) bw = W - x;
      var bh = sn(minH + rnd() * (maxH - minH));
      var top = GROUND_Y - bh;
      g.fillStyle = fill;
      g.fillRect(x, top, bw, bh);
      g.fillStyle = edge;                 // lit roof edge
      g.fillRect(x, top, bw, PIX);
      // Windows
      for (var wy = top + 8; wy < GROUND_Y - 6; wy += 10) {
        for (var wx = x + 6; wx < x + bw - 6; wx += 8) {
          if (rnd() < 0.22) {
            g.fillStyle = winColors[Math.floor(rnd() * winColors.length)];
            g.fillRect(sn(wx), sn(wy), PIX * 2, PIX * 2);
          }
        }
      }
      x += bw;
    }
    return c;
  }

  var bgLayer = buildBackground();
  var farCity = buildSkyline(50, 130, '#2a0a55', '#7a2bbf', 12345);
  var nearCity = buildSkyline(24, 80, '#190538', '#c01fa0', 777);

  // Twinkling stars (fixed positions, each with its own rhythm)
  var stars = [];
  (function () {
    var s = 4242;
    function rnd() { s = (s * 16807) % 2147483647; return s / 2147483647; }
    for (var i = 0; i < 45; i++) {
      stars.push({
        x: sn(rnd() * W),
        y: sn(rnd() * (GROUND_Y - 220)),
        speed: 1 + rnd() * 2.5,
        phase: rnd() * 10,
        big: rnd() < 0.15
      });
    }
  })();

  // Scanlines + vignette, pre-rendered once at full canvas resolution
  var overlay = (function () {
    var c = makeCanvas(canvas.width, canvas.height);
    var g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = 'rgba(0, 0, 0, 0.12)';
    for (var y = 0; y < H; y += PIX * 2) g.fillRect(0, y + PIX, W, PIX);
    var v = g.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 0.75);
    v.addColorStop(0, 'rgba(0, 0, 0, 0)');
    v.addColorStop(1, 'rgba(0, 0, 0, 0.4)');
    g.fillStyle = v;
    g.fillRect(0, 0, W, H);
    return c;
  })();

  // ---- Drawing --------------------------------------------------------

  function drawStars() {
    stars.forEach(function (st) {
      var tw = Math.sin(time * st.speed + st.phase);
      o.fillStyle = tw > 0.3 ? '#ffffff' : (tw > -0.5 ? '#b8a0ff' : '#5a4a8a');
      o.fillRect(st.x, st.y, PIX, PIX);
      if (st.big && tw > 0) {                       // little plus-shaped sparkle
        o.fillRect(st.x - PIX, st.y, PIX, PIX);
        o.fillRect(st.x + PIX, st.y, PIX, PIX);
        o.fillRect(st.x, st.y - PIX, PIX, PIX);
        o.fillRect(st.x, st.y + PIX, PIX, PIX);
      }
    });
  }

  // Scrolling skyline strip; "factor" is its parallax speed vs the pipes
  function drawCity(layer, factor) {
    var x = -sn((scroll * factor) % W);
    o.drawImage(layer, x, 0, W, GROUND_Y);
    o.drawImage(layer, x + W, 0, W, GROUND_Y);
  }

  // Neon perspective grid instead of a ground
  function drawFloor() {
    var cx = W / 2;
    o.fillStyle = DARK;
    o.fillRect(0, GROUND_Y, W, GROUND_H);
    // Darker toward the bottom
    o.fillStyle = 'rgba(0, 0, 0, 0.25)';
    o.fillRect(0, GROUND_Y + GROUND_H / 2, W, GROUND_H / 2);

    // Clip to the floor first: clip() uses the current path, so it has to be
    // set up before the grid path is built
    o.save();
    o.beginPath();
    o.rect(0, GROUND_Y, W, GROUND_H);
    o.clip();

    // Collect all grid lines in one path, then stroke it twice (glow + core)
    o.beginPath();
    var phase = (scroll % 40) / 40;
    for (var i = 0; i < 6; i++) {                   // horizontal lines, bunched near the horizon
      var t = (i + phase) / 6;
      var y = sn(GROUND_Y + GROUND_H * t * t) + 1;
      o.moveTo(0, y);
      o.lineTo(W, y);
    }
    var off0 = scroll % GRID;
    for (var xb = -GRID - off0; xb < W + GRID; xb += GRID) {   // lines toward the vanishing point
      o.moveTo(cx + (xb - cx) * 0.2, GROUND_Y);
      o.lineTo(xb, H);
    }
    o.strokeStyle = 'rgba(255, 43, 214, 0.3)';
    o.lineWidth = 6;
    o.stroke();
    o.strokeStyle = MAGENTA;
    o.lineWidth = 2;
    o.stroke();
    o.restore();

    // Glowing horizon line
    o.fillStyle = 'rgba(37, 244, 238, 0.35)';
    o.fillRect(0, GROUND_Y - PIX, W, PIX * 3);
    o.fillStyle = CYAN;
    o.fillRect(0, GROUND_Y, W, PIX);
  }

  // A dark rectangle with a neon outline; the glow is faked with extra
  // wide, see-through strokes underneath (cheap, no shadowBlur)
  function neonRect(x, y, w, h, hue) {
    x = sn(x); y = sn(y); w = sn(w); h = sn(h);
    o.fillStyle = DARK;
    o.fillRect(x, y, w, h);
    o.lineJoin = 'miter';
    o.strokeStyle = 'hsla(' + hue + ', 100%, 60%, 0.18)';
    o.lineWidth = 12;
    o.strokeRect(x, y, w, h);
    o.strokeStyle = 'hsla(' + hue + ', 100%, 60%, 0.4)';
    o.lineWidth = 6;
    o.strokeRect(x, y, w, h);
    o.strokeStyle = 'hsl(' + hue + ', 100%, 72%)';
    o.lineWidth = 2;
    o.strokeRect(x + 1, y + 1, w - 2, h - 2);
  }

  function drawPipe(p) {
    var topH = p.gapY - PIPE_GAP / 2;
    var botY = p.gapY + PIPE_GAP / 2;
    var capH = 24;
    var capX = p.x - 4;
    var capW = PIPE_W + 8;
    // Hue drifts slowly between cyan (180) and magenta (300)
    var hue = Math.round(240 + 60 * Math.sin(time * 0.5 + p.id * 0.9));

    // Pipe bodies (start above / end below the screen so no stray outline)
    neonRect(p.x, -12, PIPE_W, topH + 12, hue);
    neonRect(p.x, botY, PIPE_W, GROUND_Y - botY, hue);

    // Inner highlight stripes
    o.fillStyle = 'hsla(' + hue + ', 100%, 70%, 0.25)';
    o.fillRect(sn(p.x + 10), 0, PIX * 2, sn(topH - capH - 4));
    o.fillRect(sn(p.x + 10), sn(botY + capH + 4), PIX * 2, sn(GROUND_Y - botY - capH - 4));

    // Caps at the gap
    neonRect(capX, topH - capH, capW, capH, hue);
    neonRect(capX, botY, capW, capH, hue);
  }

  function drawParticles() {
    particles.forEach(function (p) {
      o.globalAlpha = Math.max(0, Math.min(1, p.life / p.max));
      o.fillStyle = p.color;
      o.fillRect(sn(p.x), sn(p.y), PIX * 2, PIX * 2);
    });
    o.globalAlpha = 1;
  }

  // Wing frames as blocky rects [x, y, w, h] for the right wing (mirrored
  // for the left one). Three poses: up, middle, down.
  var WING_FRAMES = [
    [[24, -4, 12, 8], [32, -14, 10, 10], [38, -26, 8, 12]],   // up
    [[24, -2, 12, 8], [34, -2, 10, 8], [42, 0, 6, 6]],        // middle
    [[24, 0, 12, 8], [32, 8, 10, 10], [36, 18, 8, 12]]        // down
  ];
  var WING_SEQ = [1, 0, 1, 2];   // middle, up, middle, down

  function drawWing(side, rects) {
    var i, r, x;
    // Dark outline first, then the coloured feathers on top
    o.fillStyle = '#2a0a4a';
    for (i = 0; i < rects.length; i++) {
      r = rects[i];
      x = side > 0 ? r[0] : -r[0] - r[2];
      o.fillRect(x - PIX, r[1] - PIX, r[2] + PIX * 2, r[3] + PIX * 2);
    }
    for (i = 0; i < rects.length; i++) {
      r = rects[i];
      x = side > 0 ? r[0] : -r[0] - r[2];
      o.fillStyle = i === 0 ? '#ffe4f8' : (i === 1 ? '#ff9de2' : CYAN);
      o.fillRect(x, r[1], r[2], r[3]);
    }
  }

  function drawBird() {
    var rects = WING_FRAMES[WING_SEQ[Math.floor(wingPhase) % WING_SEQ.length]];

    // Tilt with vertical velocity, clamped and stepped (pixel-style)
    var tilt = Math.max(-0.5, Math.min(1.0, bird.vy / 600));
    tilt = Math.round(tilt * 6) / 6;

    o.save();
    o.translate(sn(BIRD_X), sn(bird.y));
    o.rotate(tilt);

    drawWing(-1, rects);
    drawWing(1, rects);

    // Neon glow ring behind the face
    o.strokeStyle = 'rgba(37, 244, 238, 0.25)';
    o.lineWidth = 10;
    o.beginPath();
    o.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    o.stroke();

    if (faceLoaded) {
      // Smoothing on only here, so the big photo shrinks cleanly into the
      // low-res canvas and stays recognisable
      o.imageSmoothingEnabled = true;
      o.drawImage(face, -BIRD_R, -BIRD_R, BIRD_R * 2, BIRD_R * 2);
      o.imageSmoothingEnabled = false;
      o.strokeStyle = CYAN;
      o.lineWidth = 4;
      o.beginPath();
      o.arc(0, 0, BIRD_R, 0, Math.PI * 2);
      o.stroke();
    } else {
      // Fallback: simple yellow bird
      o.fillStyle = '#f7d51d';
      o.strokeStyle = '#2a0a4a';
      o.lineWidth = 4;
      o.beginPath();
      o.arc(0, 0, BIRD_R, 0, Math.PI * 2);
      o.fill();
      o.stroke();
      o.fillStyle = '#000';
      o.fillRect(8, -12, 6, 6);
    }
    o.restore();
  }

  // Arcade text with a hard (not blurred) drop shadow.
  // Sizes that are multiples of 16 stay sharp: the font is 8px per 16 logical px.
  function drawText(text, x, y, size, color, shadow) {
    o.font = size + 'px ' + FONT;
    o.textAlign = 'center';
    o.textBaseline = 'middle';
    x = sn(x);
    y = sn(y);
    var d = size / 8;
    o.fillStyle = shadow || '#2a0a4a';
    o.fillText(text, x + d, y + d);
    o.fillStyle = color || '#ffffff';
    o.fillText(text, x, y);
  }

  function blink(rate) { return Math.floor(time * rate) % 2 === 0; }

  function drawUI() {
    if (state === 'ready') {
      drawText('FLAPPY THOM', W / 2, 150, 32, '#ffe94d', '#ff2bd6');
      if (blink(2)) drawText('TAP TO START', W / 2, 220, 16, '#ffffff', '#ff2bd6');
      if (best > 0) drawText('BEST ' + best, W / 2, 280, 16, CYAN);
    } else if (state === 'playing') {
      // Score with a pop (scale bump) when a point is scored
      var s = 1 + scorePop * 0.4;
      o.save();
      o.translate(W / 2, 80);
      o.scale(s, s);
      drawText(String(score), 0, 0, 48, '#ffffff', MAGENTA);
      o.restore();
    } else {
      // Game over panel
      var px = 40, py = 100, pw = W - 80, ph = 290;
      o.fillStyle = 'rgba(10, 0, 30, 0.85)';
      o.fillRect(px, py, pw, ph);
      o.strokeStyle = 'rgba(255, 43, 214, 0.3)';
      o.lineWidth = 10;
      o.strokeRect(px, py, pw, ph);
      o.strokeStyle = MAGENTA;
      o.lineWidth = 4;
      o.strokeRect(px, py, pw, ph);

      drawText('GAME OVER', W / 2, 145, 32, '#ff5a5a', '#2a0a4a');
      drawText('SCORE', W / 2, 205, 16, CYAN);
      drawText(String(score), W / 2, 240, 32, '#ffffff', MAGENTA);
      drawText('BEST', W / 2, 290, 16, CYAN);
      drawText(String(best), W / 2, 325, 32, '#ffe94d', MAGENTA);
      if (newBest && blink(3)) drawText('NEW BEST!', W / 2, 365, 16, '#ffe94d', '#ff2bd6');
      if (overTime >= RESTART_DELAY && blink(2)) drawText('TAP TO RETRY', W / 2, 430, 16, '#ffffff', '#ff2bd6');
    }
  }

  // Draw the whole scene into the low-res canvas
  function drawScene() {
    o.drawImage(bgLayer, 0, 0, W, H);
    drawStars();
    drawCity(farCity, 0.12);
    drawCity(nearCity, 0.3);
    drawFloor();
    pipes.forEach(drawPipe);
    drawParticles();
    drawBird();
    drawUI();
  }

  function draw() {
    drawScene();

    // Scale the low-res scene up onto the visible canvas (with screen shake)
    var sx = 0;
    var sy = 0;
    if (shakeT > 0) {
      var mag = 10 * (shakeT / SHAKE_TIME);
      sx = sn((Math.random() * 2 - 1) * mag);
      sy = sn((Math.random() * 2 - 1) * mag);
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(off, sx, sy, W, H);

    // One short, soft flash on a crash (max 35% opacity, fades out, no strobing)
    if (flashT > 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, ' + (FLASH_ALPHA * flashT / FLASH_TIME).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }

    // CRT scanlines and vignette
    ctx.drawImage(overlay, 0, 0, W, H);
  }

  // ---- Main loop (delta-time, so speed matches on any refresh rate) ---

  var lastTime = null;

  function frame(now) {
    if (lastTime === null) lastTime = now;
    var dt = Math.min((now - lastTime) / 1000, 0.05);  // clamp after tab switch
    lastTime = now;
    update(dt);
    draw();
    requestAnimationFrame(frame);
  }

  // Wait for the pixel font before the first frame so text never flashes in
  // the wrong font. If it fails or is slow, start anyway (FONT falls back).
  var started = false;
  function start() {
    if (started) return;
    started = true;
    requestAnimationFrame(frame);
  }

  if (document.fonts && document.fonts.load) {
    document.fonts.load('16px "Press Start 2P"').then(start, start);
    setTimeout(start, 2500);
  } else {
    start();
  }
})();
