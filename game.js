// Flappy Thom: a small Flappy Bird-style game on a canvas.
// Game logic runs on a fixed logical size (400x600); CSS scales the canvas.

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

  // Make the canvas crisp on high-DPI screens
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

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
  var BIRD_R = 23;           // face diameter 46px
  var HIT_R = BIRD_R - 3;    // slightly forgiving hitbox
  var RESTART_DELAY = 0.5;   // seconds before game over can be dismissed

  // ---- State ----------------------------------------------------------

  var state = 'ready';       // 'ready' | 'playing' | 'over'
  var bird, pipes, score, best, flapBoost, wingTime, groundX, overTime;
  var clouds = [
    { x: 40, y: 90, s: 1 },
    { x: 220, y: 160, s: 0.7 },
    { x: 340, y: 60, s: 0.85 }
  ];

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
    score = 0;
    flapBoost = 0;
    wingTime = 0;
    groundX = 0;
    overTime = 0;
    state = 'ready';
  }

  // ---- Best score storage ---------------------------------------------

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

  // ---- Input ----------------------------------------------------------

  function flap() {
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
  }

  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    flap();
  });

  window.addEventListener('keydown', function (e) {
    if (e.code === 'Space' || e.code === 'ArrowUp') {
      e.preventDefault();       // keep the page from scrolling
      if (!e.repeat) flap();
    }
  });

  // ---- Pipes ----------------------------------------------------------

  function spawnPipe(x) {
    var min = GAP_MARGIN + PIPE_GAP / 2;
    var max = GROUND_Y - GAP_MARGIN - PIPE_GAP / 2;
    pipes.push({
      x: x,
      gapY: min + Math.random() * (max - min),  // centre of the gap
      passed: false
    });
  }

  // ---- Update ---------------------------------------------------------

  function update(dt) {
    wingTime += dt;
    flapBoost = Math.max(0, flapBoost - dt * 3);

    if (state === 'ready') {
      // Gentle bobbing while waiting
      bird.y = H / 2 - 40 + Math.sin(wingTime * 4) * 8;
      groundX = (groundX + PIPE_SPEED * dt) % 24;
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

    // Bird physics
    bird.vy = Math.min(bird.vy + GRAVITY * dt, MAX_FALL);
    bird.y += bird.vy * dt;

    // Move pipes and spawn new ones at an even distance
    for (var i = 0; i < pipes.length; i++) pipes[i].x -= PIPE_SPEED * dt;
    var last = pipes[pipes.length - 1];
    if (!last || last.x <= W + 60 - PIPE_SPACING) spawnPipe(last ? last.x + PIPE_SPACING : W + 60);
    if (pipes[0].x + PIPE_W < -10) pipes.shift();

    groundX = (groundX + PIPE_SPEED * dt) % 24;

    // Score: bird centre passed the pipe's right edge
    pipes.forEach(function (p) {
      if (!p.passed && p.x + PIPE_W < BIRD_X) {
        p.passed = true;
        score++;
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
        saveBest();
      }
    }
  }

  function circleHitsRect(cx, cy, r, rx, ry, rw, rh) {
    var nx = Math.max(rx, Math.min(cx, rx + rw));
    var ny = Math.max(ry, Math.min(cy, ry + rh));
    var dx = cx - nx;
    var dy = cy - ny;
    return dx * dx + dy * dy < r * r;
  }

  // ---- Drawing --------------------------------------------------------

  function drawCloud(c) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.beginPath();
    ctx.arc(c.x, c.y, 22 * c.s, 0, Math.PI * 2);
    ctx.arc(c.x + 24 * c.s, c.y - 8 * c.s, 28 * c.s, 0, Math.PI * 2);
    ctx.arc(c.x + 52 * c.s, c.y, 22 * c.s, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPipe(p) {
    var topH = p.gapY - PIPE_GAP / 2;
    var botY = p.gapY + PIPE_GAP / 2;
    var capH = 24;
    var capX = p.x - 4;
    var capW = PIPE_W + 8;

    ctx.fillStyle = '#5bbf3a';
    ctx.strokeStyle = '#2f7a1e';
    ctx.lineWidth = 3;

    // Pipe bodies
    ctx.fillRect(p.x, 0, PIPE_W, topH);
    ctx.strokeRect(p.x, -2, PIPE_W, topH + 2);
    ctx.fillRect(p.x, botY, PIPE_W, GROUND_Y - botY);
    ctx.strokeRect(p.x, botY, PIPE_W, GROUND_Y - botY + 2);

    // Caps at the gap
    ctx.fillRect(capX, topH - capH, capW, capH);
    ctx.strokeRect(capX, topH - capH, capW, capH);
    ctx.fillRect(capX, botY, capW, capH);
    ctx.strokeRect(capX, botY, capW, capH);

    // Highlight stripe
    ctx.fillStyle = 'rgba(255, 255, 255, 0.25)';
    ctx.fillRect(p.x + 8, 0, 8, topH - capH - 4);
    ctx.fillRect(p.x + 8, botY + capH + 4, 8, GROUND_Y - botY - capH - 4);
  }

  function drawGround() {
    ctx.fillStyle = '#ded895';
    ctx.fillRect(0, GROUND_Y, W, GROUND_H);
    ctx.fillStyle = '#73bf2e';
    ctx.fillRect(0, GROUND_Y, W, 14);
    // Scrolling stripes on the grass
    ctx.fillStyle = '#5fa023';
    for (var x = -groundX; x < W; x += 24) {
      ctx.beginPath();
      ctx.moveTo(x, GROUND_Y);
      ctx.lineTo(x + 12, GROUND_Y);
      ctx.lineTo(x + 4, GROUND_Y + 14);
      ctx.lineTo(x - 8, GROUND_Y + 14);
      ctx.fill();
    }
    ctx.strokeStyle = '#4a7d1c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, GROUND_Y);
    ctx.lineTo(W, GROUND_Y);
    ctx.stroke();
  }

  // One wing: a light ellipse with outline, flapping around its shoulder
  function drawWing(side, angle) {
    ctx.save();
    ctx.translate(side * 14, 4);
    ctx.rotate(side * angle);
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#4a4a4a';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(side * 12, 0, 16, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  function drawBird() {
    // Wing flap: faster and bigger right after a tap
    var speed = 12 + flapBoost * 22;
    var swing = 0.35 + flapBoost * 0.55;
    var angle = -0.2 + Math.sin(wingTime * speed) * swing;

    // Tilt with vertical velocity, clamped
    var tilt = Math.max(-0.5, Math.min(1.0, bird.vy / 600));

    ctx.save();
    ctx.translate(BIRD_X, bird.y);
    ctx.rotate(tilt);

    drawWing(-1, angle);
    drawWing(1, angle);

    if (faceLoaded) {
      ctx.drawImage(face, -BIRD_R, -BIRD_R, BIRD_R * 2, BIRD_R * 2);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      // Fallback: simple yellow bird
      ctx.fillStyle = '#f7d51d';
      ctx.strokeStyle = '#4a4a4a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.arc(8, -6, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Text with a dark outline so it reads on any background
  function drawText(text, x, y, size) {
    ctx.font = 'bold ' + size + 'px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(4, size / 6);
    ctx.strokeStyle = '#333';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = '#fff';
    ctx.fillText(text, x, y);
  }

  function draw() {
    // Sky
    var sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
    sky.addColorStop(0, '#4ec0ca');
    sky.addColorStop(1, '#a8e4ee');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    clouds.forEach(drawCloud);
    pipes.forEach(drawPipe);
    drawGround();
    drawBird();

    if (state === 'ready') {
      drawText('Tap to start', W / 2, 190, 36);
    } else if (state === 'playing') {
      drawText(String(score), W / 2, 70, 64);
    } else {
      // Game over panel
      drawText('Game over', W / 2, 150, 44);
      drawText('Score: ' + score, W / 2, 215, 32);
      drawText('Best: ' + best, W / 2, 255, 32);
      if (overTime >= RESTART_DELAY) drawText('Tap to play again', W / 2, 315, 26);
    }
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

  requestAnimationFrame(frame);
})();
