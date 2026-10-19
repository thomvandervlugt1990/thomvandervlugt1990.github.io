// Tractor Run: an OutRun-style pseudo-3D racing game where you drive a
// tractor through the Dutch countryside.
//
// The road is a list of short segments, projected to the screen back to
// front (the classic "javascript-racer" technique). Everything is drawn
// procedurally on a canvas: no image files, no libraries.
// The scene is drawn to a small offscreen canvas (240x180) and scaled up
// with smoothing off, which gives the chunky pixel look.

(function () {
  'use strict';

  // ---- Setup ----------------------------------------------------------

  var canvas = document.getElementById('tractor-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');

  var W = 480;             // logical canvas size (CSS scales it, 4:3)
  var H = 360;
  var PIX = 2;             // logical pixels per "retro pixel"
  var LW = W / PIX;        // low-res scene size: 240
  var LH = H / PIX;        // 180

  // Make the canvas crisp on high-DPI screens
  var dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;

  // Low-res offscreen canvas: all drawing happens here, in retro pixels
  var off = makeCanvas(LW, LH);
  var o = off.getContext('2d');
  o.imageSmoothingEnabled = false;

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }

  var reduceMotion = false;
  try {
    reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) { /* matchMedia unavailable: ignore */ }

  // ---- Tuning ---------------------------------------------------------

  // Road / camera (classic projection values)
  var SEG_LEN = 200;           // length of one road segment (world units)
  var RUMBLE_LEN = 3;          // segments per rumble-strip colour
  var ROAD_W = 1400;           // half the road width (world units)
  var LANES = 2;
  var FOV = 100;
  var CAM_H = 1000;            // camera height above the road
  var DRAW_DIST = 150;         // segments drawn per frame
  var CAM_DEPTH = 1 / Math.tan((FOV / 2) * Math.PI / 180);
  var PLAYER_Z = CAM_H * CAM_DEPTH;    // distance from camera to the tractor
  var HORIZON = 78;            // screen y of the horizon (low-res px)

  // Driving
  var MAX_SPEED = 6000;        // world units per second (= 60 km/h on screen)
  var KMH_TOP = 60;
  var M_PER_UNIT = 0.00278;    // 6000 units/s = 16.7 m/s = 60 km/h
  var ACCEL = MAX_SPEED / 6.5; // about 6.5 s from standstill to top speed
  var COAST = -MAX_SPEED / 9;  // slow-down when no pedal is pressed
  var BRAKE = -MAX_SPEED / 1.8;
  var OFFROAD_DECEL = -MAX_SPEED / 1.5;
  var OFFROAD_LIMIT = MAX_SPEED * 0.28;   // grass slows you down to ~17 km/h
  var STEER = 2.0;             // road half-widths per second at full speed
  var CENTRIFUGAL = 0.28;      // how hard curves push you outward
  var PLAYER_HW = 0.11;        // half width of the tractor (road half-widths)
  var PLAYER_S = 0.72;         // tractor sprite scale
  var PLAYER_BY = 172;         // screen y of the tractor's wheels

  // Rules
  var TIME_START = 60;         // seconds on the clock at the start
  var CP_SPACING = 600;        // segments between checkpoints
  var CP_OFFSET = 560;         // first checkpoint segment inside a lap
  var BONUS_FIRST = 28;        // seconds for the first checkpoint ...
  var BONUS_STEP = 3;          // ... each next one gives this much less ...
  var BONUS_MIN = 14;          // ... down to this
  var OVERTAKE_POINTS = 50;
  var RESTART_DELAY = 1.2;     // seconds before game over can be dismissed
  var NUM_CARS = 36;

  // Crashes and the time-up explosion
  var G_WORLD = 9000;          // gravity for knocked-away objects (world units / s^2)
  var BIT_MAX = 70;            // cap on small world-space debris bits
  var BOOM_G = 300;            // gravity for the exploding tractor's pieces (px / s^2)
  var FX_MAX = 90;             // cap on explosion fire / smoke particles
  var BOOM_PANEL_DELAY = 1.8;  // seconds of explosion before the TIME UP panel

  // ---- Look: palette and fonts ----------------------------------------

  var FONT = '"Press Start 2P", monospace';   // falls back to monospace by itself
  var COL_LIGHT = { road: '#767982', grass: '#70d055', rumble: '#e03a2f', lane: '#f4f4f4' };
  var COL_DARK = { road: '#6d7079', grass: '#5fbf48', rumble: '#f4f4f4', lane: null };
  var TIRE = '#202020';
  var TREAD = '#3c3c3c';

  // ---- Small helpers --------------------------------------------------

  function mod(a, b) { return ((a % b) + b) % b; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function easeIn(a, b, p) { return a + (b - a) * p * p; }
  function easeInOut(a, b, p) { return a + (b - a) * ((-Math.cos(p * Math.PI) / 2) + 0.5); }
  function approach(v, target, step) {
    return v < target ? Math.min(v + step, target) : Math.max(v - step, target);
  }

  // Small deterministic random so the track looks the same on each load
  var seed = 20260101;
  function rnd() {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  }
  function pick(list) { return list[Math.floor(rnd() * list.length)]; }

  // ---- Storage ---------------------------------------------------------

  function loadBest() {
    try {
      return parseInt(localStorage.getItem('tractorRunBest'), 10) || 0;
    } catch (e) {
      return 0;
    }
  }

  function saveBest() {
    try {
      localStorage.setItem('tractorRunBest', String(best));
    } catch (e) { /* storage unavailable: ignore */ }
  }

  function loadMuted() {
    try {
      return localStorage.getItem('tractorRunMuted') === '1';
    } catch (e) {
      return false;   // default: sound on
    }
  }

  function saveMuted() {
    try {
      localStorage.setItem('tractorRunMuted', muted ? '1' : '0');
    } catch (e) { /* storage unavailable: ignore */ }
  }

  // ---- Track -----------------------------------------------------------

  var segments = [];
  var N = 0;                   // number of segments
  var trackLength = 0;

  function lastY() {
    return segments.length ? segments[segments.length - 1].y2 : 0;
  }

  function addSegment(curve, y) {
    var n = segments.length;
    segments.push({
      i: n,
      z1: n * SEG_LEN,
      z2: (n + 1) * SEG_LEN,
      y1: lastY(),
      y2: y,
      curve: curve,
      light: Math.floor(n / RUMBLE_LEN) % 2 === 0,
      cp: false,                // checkpoint banner here?
      sprites: [],
      cars: [],
      fx: [],                   // flying crash parts drawn at this segment (per frame)
      // filled in every frame by render():
      sx1: 0, sy1: 0, sw1: 0, sc1: 0, cz: 0,
      sx2: 0, sy2: 0, sw2: 0, sc2: 0,
      clip: 0
    });
  }

  // One section of road: ease into the curve / hill, hold it, ease out.
  // "y" is the height change of the whole section, in segments.
  function addRoad(enter, hold, leave, curve, y) {
    var startY = lastY();
    var endY = startY + y * SEG_LEN;
    var total = enter + hold + leave;
    var n;
    for (n = 0; n < enter; n++) {
      addSegment(easeIn(0, curve, n / enter), easeInOut(startY, endY, (n + 1) / total));
    }
    for (n = 0; n < hold; n++) {
      addSegment(curve, easeInOut(startY, endY, (enter + n + 1) / total));
    }
    for (n = 0; n < leave; n++) {
      addSegment(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n + 1) / total));
    }
  }

  // A section of 3*n segments
  function road(n, curve, y) { addRoad(n, n, n, curve, y); }

  // Gentle up and down hills (18*n segments, net height change = h)
  function rolling(n, h) {
    addRoad(n, n, n, 0, h / 2);
    addRoad(n, n, n, 0, -h);
    addRoad(n, n, n, 1.2, h);
    addRoad(n, n, n, 0, 0);
    addRoad(n, n, n, -1.2, h / 2);
    addRoad(n, n, n, 0, 0);
  }

  // Curves: easy, medium, hard (a hard one at full speed needs a lift)
  var C_EASY = 1.2;
  var C_MED = 2.4;
  var C_HARD = 3.6;

  // A stretch of about 1200 segments; sign mirrors the curves, hs scales hills
  function chunk(sign, hs) {
    var HL = 5 * hs, HM = 10 * hs, HH = 16 * hs;
    road(10, 0, 0);
    road(12, C_EASY * sign, 0);
    road(10, 0, HM);
    road(12, -C_MED * sign, HL);
    road(12, 0, -HM);
    road(8, C_MED * sign, 0);
    rolling(7, HL);
    scurves(sign);
    road(12, 0, HH);
    road(10, C_MED * sign, 0);
    road(14, 0, -HH);
    road(10, -C_HARD * sign, 0);
    road(10, 0, 0);
    rolling(6, HM);
    road(12, C_MED * sign, 0);
    road(12, -C_EASY * sign, -HL);
    road(10, 0, 0);
    road(14, -C_MED * sign, HM);
    road(14, C_MED * sign, -HM);
    road(8, C_EASY * sign, 0);
    road(8, -C_HARD * sign, 0);
    road(8, C_MED * sign, 0);
    road(8, -C_EASY * sign, 0);
    road(12, 0, HM);
    road(12, 0, -HH);
    rolling(8, HM);
    road(12, 0, -lastY() / SEG_LEN);   // back down to ground level
  }

  function scurves(sign) {
    road(9, -C_EASY * sign, 0);
    road(9, C_MED * sign, 0);
    road(9, -C_HARD * sign, 0);
    road(9, C_EASY * sign, 0);
  }

  function buildTrack() {
    segments = [];
    chunk(1, 1);
    chunk(-1, 0.8);
    // A shorter third part, then pad to a whole number of checkpoint legs
    road(10, 0, 0);
    road(12, C_EASY, 0);
    road(10, 0, 8);
    road(12, -C_MED, 4);
    scurves(-1);
    var target = Math.ceil((segments.length + 45) / CP_SPACING) * CP_SPACING;
    var remaining = target - segments.length;
    var r = Math.floor(remaining / 3);
    road(r, 0, -lastY() / SEG_LEN);    // closing downhill so the loop is seamless
    while (segments.length < target) addSegment(0, lastY());

    N = segments.length;
    trackLength = N * SEG_LEN;
    for (var i = 0; i < N; i++) {
      if (i % CP_SPACING === CP_OFFSET) segments[i].cp = true;
    }
  }

  function findSegment(z) {
    return segments[Math.floor(mod(z, trackLength) / SEG_LEN)];
  }

  // ---- Roadside sprites (procedural drawings) -------------------------
  // Each draw function gets the bottom-centre of the sprite (x, y) and its
  // size in screen pixels (w, h). "box" draws a rectangle in fractions of
  // that size: ax is measured from the centre, ay upward from the bottom.

  var flipDir = 1;

  function box(g, col, x, y, w, h, ax, ay, aw, ah) {
    if (flipDir < 0) ax = -ax - aw;
    var x0 = Math.round(x + ax * w);
    var y0 = Math.round(y - (ay + ah) * h);
    var x1 = Math.round(x + (ax + aw) * w);
    var y1 = Math.round(y - ay * h);
    if (x1 <= x0) x1 = x0 + 1;
    if (y1 <= y0) y1 = y0 + 1;
    g.fillStyle = col;
    g.fillRect(x0, y0, x1 - x0, y1 - y0);
  }

  function drawTree(g, x, y, w, h) {
    box(g, '#6b4423', x, y, w, h, -0.07, 0, 0.14, 0.42);
    box(g, '#2f8a3a', x, y, w, h, -0.42, 0.28, 0.84, 0.26);
    box(g, '#3da24a', x, y, w, h, -0.5, 0.46, 1.0, 0.28);
    box(g, '#4cb85a', x, y, w, h, -0.34, 0.7, 0.68, 0.3);
    box(g, '#6ad176', x, y, w, h, -0.2, 0.84, 0.18, 0.1);
  }

  function drawPoplar(g, x, y, w, h) {
    box(g, '#6b4423', x, y, w, h, -0.07, 0, 0.14, 0.2);
    box(g, '#2f8a3a', x, y, w, h, -0.32, 0.12, 0.64, 0.3);
    box(g, '#3da24a', x, y, w, h, -0.4, 0.32, 0.8, 0.3);
    box(g, '#4cb85a', x, y, w, h, -0.3, 0.58, 0.6, 0.26);
    box(g, '#5fca6c', x, y, w, h, -0.16, 0.8, 0.32, 0.2);
  }

  function drawWindmill(g, x, y, w, h, e) {
    box(g, '#b5523b', x, y, w, h, -0.30, 0, 0.60, 0.10);
    box(g, '#efe6d6', x, y, w, h, -0.27, 0.10, 0.54, 0.18);
    box(g, '#e4d9c4', x, y, w, h, -0.22, 0.28, 0.44, 0.18);
    box(g, '#efe6d6', x, y, w, h, -0.17, 0.46, 0.34, 0.16);
    box(g, '#8b3a2a', x, y, w, h, -0.20, 0.62, 0.40, 0.06);
    box(g, '#a5482f', x, y, w, h, -0.12, 0.68, 0.24, 0.04);
    box(g, '#6b4a2e', x, y, w, h, -0.06, 0.10, 0.12, 0.12);
    drawSails(g, x, y - 0.64 * h, 0.7 * w, w, (e && e.phase) || 0);
  }

  // Four turning sails around a hub (used by sprites and the background)
  function drawSails(g, hx, hy, r, w, phase) {
    if (r < 3) return;
    var ang = time * 0.9 + phase;
    var thin = Math.max(1, w * 0.04);
    var cloth = Math.max(1, w * 0.12);
    for (var k = 0; k < 4; k++) {
      var a = ang + k * Math.PI / 2;
      var ca = Math.cos(a);
      var sa = Math.sin(a);
      g.lineWidth = thin;
      g.strokeStyle = '#5a3a22';
      g.beginPath();
      g.moveTo(hx, hy);
      g.lineTo(hx + ca * r, hy + sa * r);
      g.stroke();
      g.lineWidth = cloth;
      g.strokeStyle = '#f1ede2';
      g.beginPath();
      g.moveTo(hx + ca * r * 0.4, hy + sa * r * 0.4);
      g.lineTo(hx + ca * r, hy + sa * r);
      g.stroke();
    }
    g.fillStyle = '#3a2a1a';
    var hub = Math.max(1, Math.round(w * 0.05));
    g.fillRect(Math.round(hx - hub), Math.round(hy - hub), hub * 2, hub * 2);
  }

  function drawBarn(g, x, y, w, h) {
    box(g, '#b3322a', x, y, w, h, -0.5, 0, 1.0, 0.58);
    box(g, '#8f241f', x, y, w, h, -0.5, 0, 1.0, 0.05);
    box(g, '#5b4a47', x, y, w, h, -0.5, 0.58, 1.0, 0.10);
    box(g, '#6d5a56', x, y, w, h, -0.42, 0.68, 0.84, 0.12);
    box(g, '#5b4a47', x, y, w, h, -0.3, 0.80, 0.6, 0.12);
    box(g, '#6d5a56', x, y, w, h, -0.16, 0.92, 0.32, 0.08);
    box(g, '#f3ecdc', x, y, w, h, -0.18, 0, 0.36, 0.42);      // big white-framed door
    box(g, '#8f241f', x, y, w, h, -0.14, 0, 0.28, 0.38);
    box(g, '#f3ecdc', x, y, w, h, -0.14, 0.18, 0.28, 0.03);
    box(g, '#f3ecdc', x, y, w, h, -0.01, 0, 0.02, 0.38);
    box(g, '#f3ecdc', x, y, w, h, -0.04, 0.68, 0.08, 0.1);    // hay window
  }

  function drawHay(g, x, y, w, h) {
    box(g, '#e6c94a', x, y, w, h, -0.5, 0.14, 1.0, 0.72);
    box(g, '#e6c94a', x, y, w, h, -0.38, 0, 0.76, 1.0);
    box(g, '#cfa93a', x, y, w, h, -0.3, 0.22, 0.6, 0.56);
    box(g, '#e6c94a', x, y, w, h, -0.2, 0.32, 0.4, 0.36);
    box(g, '#b99a2c', x, y, w, h, -0.08, 0.44, 0.16, 0.12);
    box(g, '#b99a2c', x, y, w, h, -0.5, 0.1, 1.0, 0.05);
  }

  function drawCow(g, x, y, w, h, e) {
    flipDir = (e && e.flip) || 1;
    box(g, '#f4f4f4', x, y, w, h, -0.40, 0.30, 0.72, 0.42);
    box(g, '#222222', x, y, w, h, -0.30, 0.52, 0.18, 0.20);
    box(g, '#222222', x, y, w, h, -0.04, 0.34, 0.2, 0.2);
    var legs = [-0.36, -0.2, 0.1, 0.22];
    for (var i = 0; i < 4; i++) {
      box(g, '#e8e8e8', x, y, w, h, legs[i], 0.04, 0.09, 0.28);
      box(g, '#333333', x, y, w, h, legs[i], 0, 0.09, 0.06);
    }
    box(g, '#f4f4f4', x, y, w, h, 0.30, 0.44, 0.22, 0.32);
    box(g, '#f2a7b5', x, y, w, h, 0.42, 0.44, 0.10, 0.1);
    box(g, '#222222', x, y, w, h, 0.31, 0.72, 0.06, 0.08);
    box(g, '#222222', x, y, w, h, -0.45, 0.4, 0.05, 0.3);
  }

  var TULIP_SETS = [
    ['#e63946', '#f6d743'],
    ['#ff7bb0', '#b44bd6'],
    ['#ff9f1c', '#e63946'],
    ['#f6d743', '#ffffff']
  ];

  function drawTulips(g, x, y, w, h, e) {
    var set = TULIP_SETS[((e && e.v) || 0) % TULIP_SETS.length];
    for (var row = 0; row < 4; row++) {
      box(g, set[row % 2], x, y, w, h, -0.5, row * 0.25 + 0.06, 1.0, 0.19);
      box(g, '#3f9a3a', x, y, w, h, -0.5, row * 0.25, 1.0, 0.06);
    }
  }

  function drawSign(g, x, y, w, h) {
    box(g, '#9aa0a8', x, y, w, h, -0.05, 0, 0.1, 0.62);
    box(g, '#f4f4f4', x, y, w, h, -0.5, 0.55, 1.0, 0.42);
    box(g, '#1d5fc1', x, y, w, h, -0.44, 0.59, 0.88, 0.34);
    box(g, '#f4f4f4', x, y, w, h, -0.32, 0.78, 0.64, 0.05);
    box(g, '#f4f4f4', x, y, w, h, -0.32, 0.66, 0.44, 0.05);
  }

  // World size (w) and shape (h, same units) of each roadside sprite.
  // solid: hitting it stops you. hit: width of the solid part (fraction of w).
  // small: gets knocked flying when hit (the big ones stay put and shake).
  var SPRITES = {
    tree:     { w: 520,  h: 1500, solid: true,  hit: 0.3,  draw: drawTree },
    poplar:   { w: 300,  h: 1900, solid: true,  hit: 0.4,  draw: drawPoplar },
    windmill: { w: 1700, h: 3300, solid: true,  hit: 0.5,  draw: drawWindmill },
    barn:     { w: 2000, h: 1250, solid: true,  hit: 0.9,  draw: drawBarn },
    hay:      { w: 460,  h: 460,  solid: true,  hit: 0.9,  draw: drawHay,  small: true },
    cow:      { w: 720,  h: 480,  solid: true,  hit: 0.8,  draw: drawCow,  small: true },
    tulips:   { w: 2400, h: 260,  solid: false, hit: 0,    draw: drawTulips },
    sign:     { w: 380,  h: 900,  solid: true,  hit: 0.6,  draw: drawSign, small: true }
  };

  function addSprite(index, type, offset) {
    if (index < 0 || index >= N) return;
    segments[index].sprites.push({
      type: type,
      offset: offset,
      flip: rnd() < 0.5 ? 1 : -1,
      v: Math.floor(rnd() * 4),
      phase: rnd() * 6
    });
  }

  function side() { return rnd() < 0.5 ? -1 : 1; }

  // Scatter scenery along the track. The countryside changes every 150
  // segments: farmland, tulip fields, windmill country, tree-lined road.
  function placeSprites() {
    for (var n = 12; n < N; n += 2) {
      var biome = Math.floor(n / 150) % 4;
      var s;

      // Trees close to the road (these can be hit if you drive off)
      if (n % 6 === 0 && rnd() < (biome === 3 ? 0.95 : 0.55)) {
        s = side();
        addSprite(n, rnd() < 0.5 ? 'tree' : 'poplar', s * (1.35 + rnd() * 0.9));
        if (biome === 3 && rnd() < 0.6) addSprite(n, 'tree', -s * (1.4 + rnd() * 0.8));
      }
      // Far trees for depth
      if (n % 10 === 0 && rnd() < 0.7) addSprite(n, 'tree', side() * (3.4 + rnd() * 3));

      if (biome === 0) {                                   // farmland
        if (n % 14 === 0) addSprite(n, 'hay', side() * (1.35 + rnd() * 0.6));
        if (n % 24 === 0) addSprite(n, 'cow', side() * (1.7 + rnd() * 1.2));
        if (n % 40 === 0) addSprite(n, 'barn', side() * (3.2 + rnd() * 1.2));
      } else if (biome === 1) {                            // tulip fields
        if (n % 4 === 0) {
          addSprite(n, 'tulips', -2.3 - rnd() * 0.3);
          addSprite(n, 'tulips', 2.3 + rnd() * 0.3);
        }
        if (n % 8 === 0) {
          addSprite(n, 'tulips', -4.8 - rnd() * 0.5);
          addSprite(n, 'tulips', 4.8 + rnd() * 0.5);
        }
        if (n % 50 === 0) addSprite(n, 'windmill', side() * (5.5 + rnd() * 1.5));
      } else if (biome === 2) {                            // windmill country
        if (n % 30 === 0) addSprite(n, 'windmill', side() * (3 + rnd() * 1.2));
        if (n % 22 === 0) addSprite(n, 'cow', side() * (1.7 + rnd() * 1.2));
        if (n % 60 === 0) addSprite(n, 'barn', side() * (3.5 + rnd()));
      }
      if (n % 90 === 0) addSprite(n, 'sign', side() * 1.28);
    }
  }

  // ---- Traffic -----------------------------------------------------------
  // Drawn from behind like the player. All slower than the tractor's top
  // speed, so you overtake them (or crash into them).

  var CAR_TYPES = {
    tractor: { w: 380, h: 420, hit: 0.8 },
    wagon:   { w: 520, h: 440, hit: 0.85 },
    bike:    { w: 190, h: 330, hit: 0.7 },
    sheep:   { w: 560, h: 220, hit: 0.9 }
  };

  var TRACTOR_COLORS = [
    { body: '#c0392b', dark: '#8e2a20', rim: '#e8d36a' },
    { body: '#2b6cb0', dark: '#1d4a7a', rim: '#e8d36a' },
    { body: '#e67e22', dark: '#a85a14', rim: '#d8d8d8' }
  ];

  var cars = [];

  function resetCars() {
    var i;
    for (i = 0; i < N; i++) segments[i].cars = [];
    cars = [];
    for (i = 0; i < NUM_CARS; i++) {
      var r = rnd();
      var type = r < 0.42 ? 'tractor' : (r < 0.66 ? 'wagon' : (r < 0.9 ? 'bike' : 'sheep'));
      var spec = CAR_TYPES[type];
      var car = {
        type: type,
        z: (90 + Math.floor(rnd() * (N - 120))) * SEG_LEN + rnd() * SEG_LEN,
        offset: 0,
        lat: 0,
        speed: 0,
        v: Math.floor(rnd() * TRACTOR_COLORS.length),
        hw: spec.w / ROAD_W / 2 * spec.hit,
        prevDz: 0,
        bumped: 0
      };
      var lane = rnd() < 0.5 ? -0.5 : 0.5;
      if (type === 'tractor') {
        car.offset = lane + (rnd() - 0.5) * 0.2;
        car.speed = MAX_SPEED * (0.3 + rnd() * 0.16);
      } else if (type === 'wagon') {
        car.offset = lane + (rnd() - 0.5) * 0.1;
        car.speed = MAX_SPEED * (0.24 + rnd() * 0.06);
      } else if (type === 'bike') {
        car.offset = (rnd() < 0.5 ? -1 : 1) * 0.82;
        car.speed = MAX_SPEED * (0.16 + rnd() * 0.04);
      } else {                                     // a flock crossing the road
        car.offset = (rnd() - 0.5) * 1.2;
        car.lat = (rnd() < 0.5 ? -1 : 1) * 0.1;
        car.speed = 0;
      }
      cars.push(car);
      findSegment(car.z).cars.push(car);
    }
  }

  function updateCars(dt) {
    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (car.dead) {                  // knocked out: wait, then come back far away
        car.respawn -= dt;
        if (car.respawn <= 0) respawnCar(car);
        continue;
      }
      var oldSeg = findSegment(car.z);
      car.z = mod(car.z + dt * car.speed, trackLength);
      if (car.lat) {
        car.offset += car.lat * dt;
        if (Math.abs(car.offset) > 0.75) car.lat = -car.lat;
      }
      var newSeg = findSegment(car.z);
      if (newSeg !== oldSeg) {
        oldSeg.cars.splice(oldSeg.cars.indexOf(car), 1);
        newSeg.cars.push(car);
      }
    }
  }

  // Signed distance from the player to a car along the track (>0 = ahead)
  function wrapDz(dz) {
    if (dz > trackLength / 2) dz -= trackLength;
    else if (dz < -trackLength / 2) dz += trackLength;
    return dz;
  }

  // ---- State -----------------------------------------------------------

  var state = 'title';       // 'title' | 'racing' | 'over'
  var paused = false;
  var time = 0;              // total running time, drives blinking / animation
  var best = loadBest();

  var position, speed, playerX, timeLeft, distance, bonusScore, cpCount;
  var overTime, newBest, message, messageT, popups;
  var hitCooldown, shakeT, shakeMag, bounce, steerVis, throttle, wheelPhase;
  var lastCpKey, lap, lastBeep, particles, smokeAcc;
  var bg = [0, 0, 0];        // background scroll: clouds, far hills, near hills

  // Crash effects (see the "Crashes" section)
  var fly = [];              // world-space flying parts, debris bits and popups
  var bitN = 0;              // how many of those are small debris bits
  var felled = [];           // scenery knocked away, to be put back: { seg, sp }
  var shaking = [];          // big scenery that is shaking after a hit
  var fxSegs = [];           // segments that got flying parts this frame
  var boom = null;           // the time-up explosion, when it is running

  function resetGame() {
    position = 0;
    speed = 0;
    playerX = 0;
    timeLeft = TIME_START;
    distance = 0;
    bonusScore = 0;
    cpCount = 0;
    overTime = 0;
    newBest = false;
    message = '';
    messageT = 0;
    popups = [];
    hitCooldown = 0;
    shakeT = 0;
    shakeMag = 0;
    bounce = 0;
    steerVis = 0;
    throttle = 0;
    wheelPhase = 0;
    lastCpKey = -1;
    lap = 0;
    lastBeep = -1;
    particles = [];
    smokeAcc = 0;
    restoreScenery();
    fly = [];
    bitN = 0;
    boom = null;
    resetCars();
  }

  buildTrack();
  placeSprites();
  resetGame();
  // Title screen: the tractor cruises along by itself
  speed = MAX_SPEED * 0.5;

  function score() {
    return Math.floor(distance * M_PER_UNIT) + bonusScore;
  }

  // ---- Sound (chiptune + diesel via WebAudio, no audio files) ---------

  var muted = loadMuted();
  var audio = null;          // created on the first user gesture
  var noiseBuffer = null;
  var engine = null;         // the running engine sound, if any
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

  // Short burst of noise for crashes
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

  function sfxCheckpoint() {
    tone(523, 523, 0.1, 0.07);
    tone(659, 659, 0.1, 0.07, 0.1);
    tone(784, 784, 0.1, 0.07, 0.2);
    tone(1047, 1047, 0.3, 0.07, 0.3);
  }
  function sfxCrash() { noise(0.3, 0.2); tone(140, 40, 0.35, 0.1); }
  function sfxBump() { noise(0.15, 0.14); tone(180, 70, 0.18, 0.08); }
  function sfxBeep() { tone(880, 880, 0.09, 0.06); }
  function sfxTimeUp() { tone(440, 220, 0.5, 0.05, BOOM_PANEL_DELAY); }   // when the panel shows
  function sfxClang() { noise(0.2, 0.2); tone(900, 260, 0.14, 0.08); tone(1350, 500, 0.1, 0.05, 0.03); }
  function sfxBaa() { tone(320, 250, 0.16, 0.06); tone(330, 210, 0.22, 0.06, 0.14); }
  function sfxMoo() { tone(150, 120, 0.45, 0.08); tone(155, 95, 0.3, 0.06, 0.3); }
  function sfxLeaves() { noise(0.3, 0.1); }
  function sfxSnap() { noise(0.1, 0.12); tone(700, 200, 0.08, 0.06); }
  function sfxPlanks() { noise(0.25, 0.16); tone(200, 90, 0.12, 0.07); }
  function sfxBoom() {
    noise(0.5, 0.35);
    tone(120, 30, 0.8, 0.14);
    tone(70, 25, 1.0, 0.12, 0.05);
    noise(0.3, 0.12);
  }
  function sfxStart() { tone(660, 990, 0.15, 0.06); }

  // The diesel: a low sawtooth through a low-pass filter, with a sawtooth
  // LFO on its volume to make it chug. Pitch and chug rate follow speed.
  function startEngine() {
    if (!audio || engine) return;
    var osc = audio.createOscillator();
    var filter = audio.createBiquadFilter();
    var gain = audio.createGain();
    var lfo = audio.createOscillator();
    var lfoGain = audio.createGain();
    osc.type = 'sawtooth';
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    lfo.type = 'sawtooth';
    gain.gain.value = 0;
    lfoGain.gain.value = 0.03;
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(audio.destination);
    lfo.connect(lfoGain);
    lfoGain.connect(gain.gain);
    osc.start();
    lfo.start();
    engine = { osc: osc, gain: gain, lfo: lfo, lfoGain: lfoGain };
  }

  function stopEngine() {
    if (!engine) return;
    var e = engine;
    engine = null;
    var t = audio.currentTime;
    try {
      e.lfoGain.disconnect();
      e.gain.gain.setTargetAtTime(0, t, 0.03);
      e.osc.stop(t + 0.2);
      e.lfo.stop(t + 0.2);
    } catch (err) { /* already stopped: ignore */ }
  }

  // Called every frame: runs the engine only while racing, not paused, not muted
  function updateEngine() {
    var want = audio && !muted && !paused && state === 'racing';
    if (want && !engine) startEngine();
    if (!want && engine) stopEngine();
    if (!engine) return;
    var sp = speed / MAX_SPEED;
    var t = audio.currentTime;
    engine.osc.frequency.setTargetAtTime(38 + sp * 46 + throttle * 8, t, 0.1);
    engine.lfo.frequency.setTargetAtTime(6 + sp * 13, t, 0.1);
    engine.gain.gain.setTargetAtTime(0.05 + 0.03 * throttle, t, 0.1);
    engine.lfoGain.gain.setTargetAtTime(0.03 + 0.02 * throttle, t, 0.1);
  }

  function toggleMute() {
    muted = !muted;
    saveMuted();
    updateMuteButton();
    if (muted) {
      stopEngine();
    } else {
      unlockAudio();
      sfxStart();
    }
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', function () {
      toggleMute();
      muteBtn.blur();     // so Space / Enter keep working for the game
    });
  }
  updateMuteButton();

  // ---- Input -------------------------------------------------------------

  var keys = { up: false, down: false, left: false, right: false };
  var touch = { up: false, down: false, left: false, right: false };

  var KEY_MAP = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right'
  };

  function isTypingTarget(el) {
    if (!el || !el.tagName) return false;
    var tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function startOrRestart() {
    unlockAudio();
    if (state === 'title') {
      resetGame();
      state = 'racing';
      setMessage('GO!', '', 1);
      sfxStart();
    } else if (state === 'over') {
      if (overTime < RESTART_DELAY) return;
      resetGame();
      state = 'racing';
      setMessage('GO!', '', 1);
      sfxStart();
    }
  }

  window.addEventListener('keydown', function (e) {
    if (isTypingTarget(e.target)) return;
    var isButton = e.target && e.target.tagName === 'BUTTON';
    var action = KEY_MAP[e.code];
    if (action) {
      e.preventDefault();               // keep the page from scrolling
      keys[action] = true;
      unlockAudio();
    } else if ((e.code === 'Space' || e.code === 'Enter') && !isButton) {
      e.preventDefault();
      if (!e.repeat) startOrRestart();
    } else if (e.code === 'KeyM' && !e.repeat) {
      toggleMute();
    }
  });

  window.addEventListener('keyup', function (e) {
    var action = KEY_MAP[e.code];
    if (action) keys[action] = false;
  });

  function releaseAll() {
    var k;
    for (k in keys) keys[k] = false;
    for (k in touch) touch[k] = false;
    var btns = document.querySelectorAll('.pad-btn');
    for (var i = 0; i < btns.length; i++) btns[i].classList.remove('is-down');
  }

  window.addEventListener('blur', releaseAll);

  // Tap the canvas to start
  canvas.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    startOrRestart();
  });

  // On-screen buttons: hold to keep pressing. Pointer capture keeps the
  // press alive when the finger slides a little.
  function bindPad(id, action) {
    var btn = document.getElementById(id);
    if (!btn) return;
    var activeId = null;

    function release() {
      activeId = null;
      touch[action] = false;
      btn.classList.remove('is-down');
    }

    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      activeId = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      touch[action] = true;
      btn.classList.add('is-down');
      if (action === 'up' && (state === 'title' || state === 'over')) startOrRestart();
      else unlockAudio();
    });
    btn.addEventListener('pointerup', function (e) {
      if (e.pointerId === activeId) release();
      btn.blur();            // so keyboard keys keep driving the game
    });
    btn.addEventListener('pointercancel', release);
    btn.addEventListener('pointerleave', function (e) {
      if (e.pointerId === activeId && !btn.hasPointerCapture(e.pointerId)) release();
    });
    btn.addEventListener('lostpointercapture', release);
    btn.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  }

  bindPad('btn-left', 'left');
  bindPad('btn-right', 'right');
  bindPad('btn-gas', 'up');
  bindPad('btn-brake', 'down');

  // Pause when the tab is hidden
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      paused = true;
      releaseAll();
      stopEngine();
    } else {
      paused = false;
      lastTime = null;
      if (audio && audio.state === 'suspended') audio.resume();
    }
  });

  // ---- Particles (exhaust smoke) -----------------------------------------

  function addSmoke(x, y) {
    if (particles.length > 40) return;
    particles.push({
      x: x, y: y,
      vx: (Math.random() - 0.5) * 6 - 2,
      vy: -10 - Math.random() * 8,
      life: 0.7 + Math.random() * 0.4,
      max: 1.1,
      size: 2
    });
  }

  function updateParticles(dt) {
    for (var i = particles.length - 1; i >= 0; i--) {
      var p = particles[i];
      p.life -= dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.size += dt * 5;
    }
  }

  // ---- Crashes: knocked-away scenery, traffic and debris -----------------------
  // Whatever you hit reacts. Knocked-away objects and their debris live in
  // WORLD space: a z position along the track, a sideways position (world units
  // from the road centre) and a height above the road. Each frame they are
  // filed under the road segment they are over and drawn together with the
  // sprites of that segment, so they sit at the right depth, follow hills and
  // curves and are hidden behind crests like everything else. (A screen-space
  // version would be simpler, but it would slide against the road as you
  // drive past.) Flying parts are drawn in quarter turns (0/90/180/270
  // degrees): that keeps the pixels crisp and gives a flip-book tumble.

  var QC = [1, 0, -1, 0];       // exact cos / sin of the four quarter turns
  var QS = [0, 1, 0, -1];

  function rr(a, b) { return a + Math.random() * (b - a); }
  function rsign() { return Math.random() < 0.5 ? -1 : 1; }
  function anyOf(list) { return list[Math.floor(Math.random() * list.length)]; }

  // Filled pixel disc (used for wheels and the fireball)
  function pixelDisc(g, cx, cy, r, col) {
    cx = Math.round(cx);
    cy = Math.round(cy);
    r = Math.max(1, Math.round(r));
    g.fillStyle = col;
    for (var dy = -r; dy <= r; dy++) {
      var half = Math.floor(Math.sqrt(r * r - dy * dy) + 0.5);
      g.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
    }
  }

  // A tractor wheel seen from the side, with one spoke so you can see it spin
  function drawDiscWheel(g, cx, cy, d, rim) {
    var r = Math.max(1, Math.round(d / 2));
    pixelDisc(g, cx, cy, r, TIRE);
    if (r >= 4) pixelDisc(g, cx, cy, r * 0.65, TREAD);
    pixelDisc(g, cx, cy, Math.max(1, r * 0.4), rim);
    g.fillStyle = rim;
    g.fillRect(Math.round(cx), Math.round(cy), Math.round(r * 0.9), Math.max(1, Math.round(r * 0.2)));
    g.fillStyle = '#9a9a9a';
    g.fillRect(Math.round(cx) - 1, Math.round(cy) - r, 2, Math.max(1, Math.round(r * 0.25)));
  }

  // Three little stars circling a dazed head
  function drawStars(cx, cy, r) {
    for (var i = 0; i < 3; i++) {
      var a = time * 5 + i * 2.094;
      var sx = Math.round(cx + Math.cos(a) * r);
      var sy = Math.round(cy + Math.sin(a) * r * 0.35);
      o.fillStyle = '#ffe94d';
      o.fillRect(sx - 1, sy, 3, 1);
      o.fillRect(sx, sy - 1, 1, 3);
      o.fillStyle = '#ffffff';
      o.fillRect(sx, sy, 1, 1);
    }
  }

  // Closure that draws rectangles in design units around a bottom-centre (x, y)
  function rectIn(g, x, y, s) {
    return function (ax, ay, aw, ah, col) {
      var x0 = Math.round(x + ax * s);
      var y0 = Math.round(y + ay * s);
      var x1 = Math.round(x + (ax + aw) * s);
      var y1 = Math.round(y + (ay + ah) * s);
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 <= y0) y1 = y0 + 1;
      g.fillStyle = col;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    };
  }

  // -- Drawings for broken-off parts (same signature as the other sprites) --

  function drawWheelPart(g, x, y, w, h, e) {
    drawDiscWheel(g, x, y - w / 2, w, (e && e.rim) || '#e8d36a');
  }

  // The cyclist's bike, without the rider
  function drawBikeWreck(g, x, y, w) {
    var R = rectIn(g, x, y, w / 16);
    R(-1, -14, 2, 14, '#202020');                            // wheel
    R(-2, -17, 4, 3, '#6b4423');                             // saddle
    R(-1, -22, 2, 6, '#9aa0a8');                             // stem
    R(-6, -23, 12, 1, '#202020');                            // handlebar
  }

  // The cyclist flying through the air, or sitting dazed on the grass
  function drawRider(g, x, y, w, h, e) {
    var R = rectIn(g, x, y, w / 16);
    if (e && e.sit) {
      R(-7, -3, 6, 3, '#34495e');                            // legs stuck out
      R(1, -3, 6, 3, '#34495e');
      R(-4, -11, 8, 8, '#e8553b');                           // jacket
      R(-7, -10, 3, 6, '#e8553b');                           // arms
      R(4, -10, 3, 6, '#e8553b');
      R(-3, -17, 6, 6, '#f2c49b');                           // head
      R(-4, -19, 6, 3, '#f5d142');                           // helmet, askew
      R(-2, -15, 1, 1, '#222222');                           // dizzy eyes
      R(1, -15, 1, 1, '#222222');
    } else {
      var flap = Math.floor(time * 10) % 2;
      R(-4, -10, 3, 10, '#34495e');                          // legs
      R(1, -10, 3, 10, '#34495e');
      R(-4, -22, 8, 12, '#e8553b');                          // jacket
      R(-3, -28, 6, 6, '#f2c49b');                           // head
      R(-3, -30, 6, 3, '#f5d142');                           // helmet
      R(-8, flap ? -30 : -22, 3, 8, '#e8553b');              // flailing arms
      R(5, flap ? -22 : -30, 3, 8, '#e8553b');
    }
  }

  function drawSignBoard(g, x, y, w, h) {
    box(g, '#f4f4f4', x, y, w, h, -0.5, 0, 1.0, 1.0);
    box(g, '#1d5fc1', x, y, w, h, -0.44, 0.08, 0.88, 0.84);
    box(g, '#f4f4f4', x, y, w, h, -0.32, 0.64, 0.64, 0.1);
    box(g, '#f4f4f4', x, y, w, h, -0.32, 0.4, 0.44, 0.1);
  }

  function drawSignPole(g, x, y, w, h) {
    box(g, '#9aa0a8', x, y, w, h, -0.5, 0, 1.0, 1.0);
  }

  // One windmill sail: a pole with a bit of cloth
  function drawSailPiece(g, x, y, w, h) {
    box(g, '#5a3a22', x, y, w, h, -0.5, 0, 0.12, 1.0);
    box(g, '#f1ede2', x, y, w, h, -0.38, 0.1, 0.88, 0.7);
    box(g, '#5a3a22', x, y, w, h, -0.38, 0.4, 0.88, 0.05);
  }

  // -- World-space flying things ---------------------------------------------
  // kinds: 'part' (a rotating sprite), 'bit' (a small coloured square) and
  // 'text' (a floating popup like MOO!)

  function addFly(k, z, wx, h, vz, vx, vh, props) {
    var it = {
      k: k, z: mod(z, trackLength), wx: wx, h: h, vz: vz, vx: vx, vh: vh,
      g: G_WORLD, rest: 0.45, bounces: 1, landed: false, t: 0, life: 5,
      q: 0, vq: 0, restQ: 0, roll: false, fade: false
    };
    for (var key in props) it[key] = props[key];
    if (k === 'bit') bitN++;
    fly.push(it);
    return it;
  }

  // A burst of debris squares. opt: dir (-1/1 sideways bias), spread, vz,
  // upLo/upHi (launch speed), sizeLo/sizeHi, g, lifeLo/lifeHi, ar (width/height)
  function spawnBits(n, z, wx, hLo, hHi, cols, opt) {
    var d = opt || {};
    var spread = d.spread || 2500;
    for (var i = 0; i < n && bitN < BIT_MAX; i++) {
      addFly('bit', z + rr(-80, 80), wx + rr(-100, 100), rr(hLo, hHi),
        (d.vz || 0) + rr(-1000, 1000),
        (d.dir || 0) * spread * 0.5 + rr(-spread, spread) * 0.6,
        rr(d.upLo === undefined ? 800 : d.upLo, d.upHi || 3500),
        {
          col: anyOf(cols), size: rr(d.sizeLo || 50, d.sizeHi || 90), ar: d.ar || 1,
          g: d.g || 7000, life: rr(d.lifeLo || 0.8, d.lifeHi || 1.5), fade: true
        });
    }
  }

  var DUST = ['#a8d889', '#8cc36e', '#c9b98a'];
  var STRAW = ['#e6c94a', '#cfa93a', '#f0d65f', '#b99a2c'];
  var WOOL = ['#ffffff', '#e8e8e8', '#cfcfcf'];
  var SMOKE_GREY = ['#777777', '#999999', '#b0b0b0'];

  function puff(z, wx, h, cols, n) {
    spawnBits(n, z, wx, h, h + 200, cols,
      { spread: 1200, upLo: 300, upHi: 1800, sizeLo: 70, sizeHi: 120, g: 1500, lifeLo: 0.4, lifeHi: 0.7 });
  }

  function landFly(it) {
    it.h = 0;
    if (it.bounces > 0 && it.vh < -600) {            // bounce
      it.vh = -it.vh * it.rest;
      it.bounces--;
      it.vx *= 0.7;
      it.vz *= 0.7;
      it.vq *= 0.6;
      return;
    }
    it.vh = 0;
    it.landed = true;
    if (it.k !== 'part') return;
    if (!it.roll) { it.vq = 0; it.q = it.restQ; }
    if (it.sit) it.e.sit = true;                     // the cyclist sits down
    if (it.land === 'straw') {                       // hay bale bursts on impact
      spawnBits(10, it.z, it.wx, 50, 400, STRAW, { spread: 2200, upLo: 1200, upHi: 3500, sizeLo: 60, sizeHi: 110, g: 2200, lifeLo: 1.0, lifeHi: 1.8 });
      it.life = it.t;
    } else if (it.land === 'moo' || it.land === 'baa') {
      addFly('text', it.z, it.wx, it.bh * 1.1, 0, 0, 0, { text: it.land === 'moo' ? 'MOO!' : 'BAA!', life: 1.5 });
      if (it.land === 'moo') sfxMoo(); else sfxBaa();
    }
    if (!it.roll) puff(it.z, it.wx, 0, DUST, 4);     // a bit of dust
  }

  function expireFly(it) {
    if (it.poof) puff(it.z, it.wx, 0, it.poof, 6);
  }

  function updateFly(dt) {
    if (!fly.length) return;
    var pz = mod(position + PLAYER_Z, trackLength);
    bitN = 0;
    for (var i = fly.length - 1; i >= 0; i--) {
      var it = fly[i];
      it.t += dt;
      if (it.t >= it.life) { expireFly(it); fly.splice(i, 1); continue; }
      if (wrapDz(it.z - pz) < -SEG_LEN * 6) { fly.splice(i, 1); continue; }   // far behind
      if (it.k === 'text') { it.h += 350 * dt; continue; }
      if (!it.landed) {
        it.vh -= it.g * dt;
        it.h += it.vh * dt;
        it.q += it.vq * dt;
        if (it.h <= 0 && it.vh < 0) landFly(it);
      } else {
        var drag = Math.max(0, 1 - (it.roll ? 1.2 : 6) * dt);    // slide / roll to a stop
        it.vx *= drag;
        it.vz *= drag;
        if (it.roll) it.q += it.vx * dt / 150;
      }
      it.wx += it.vx * dt;
      it.z = mod(it.z + it.vz * dt, trackLength);
      if (it.k === 'bit') bitN++;
    }
  }

  // File every flying thing under the segment it is over (only the drawn ones)
  function bucketFx(baseSeg) {
    var i, seg;
    for (i = 0; i < fxSegs.length; i++) fxSegs[i].fx.length = 0;
    fxSegs.length = 0;
    for (i = 0; i < fly.length; i++) {
      seg = findSegment(fly[i].z);
      if (mod(seg.i - baseSeg.i, N) >= DRAW_DIST) continue;
      if (seg.fx.length === 0) fxSegs.push(seg);
      seg.fx.push(fly[i]);
    }
  }

  function drawFly(seg, it) {
    var pct = (it.z - seg.z1) / SEG_LEN;
    var pw = lerp(seg.sc1, seg.sc2, pct) * LW / 2;          // screen pixels per world unit
    var gx = lerp(seg.sx1, seg.sx2, pct) + it.wx * pw;     // road point under the object
    var gy = lerp(seg.sy1, seg.sy2, pct);
    var y = gy - it.h * pw;                                  // bottom of the object
    if (gx < -30 || gx > LW + 30) return;

    if (it.k === 'bit') {
      if (y > seg.clip) return;                              // behind a hill crest
      var sz = clamp(Math.round(it.size * pw), 1, 14);
      var bw = Math.max(1, Math.round(sz * it.ar));
      if (it.fade) o.globalAlpha = clamp((it.life - it.t) / 0.35, 0, 1);
      o.fillStyle = it.col;
      o.fillRect(Math.round(gx - bw / 2), Math.round(y - sz), bw, sz);
      o.globalAlpha = 1;
      return;
    }

    if (it.k === 'text') {
      if (y > seg.clip || pw < 0.03) return;
      drawText(it.text, Math.round(gx), Math.round(y - 8), 8, '#ffffff', 'center', '#d8202a');
      return;
    }

    // A rotating part. Blink for the last moments before it vanishes.
    if (it.life - it.t < 0.9 && Math.floor(time * 14) % 2 === 0) return;
    var w = it.dw * pw;
    if (w < 1.5) return;
    var vw = it.bw * pw;
    var vh = it.bh * pw;
    var qi = mod(Math.floor(it.q), 4);
    var cy = y - ((qi & 1) ? vw : vh) / 2;                  // box centre (a side-on box is wider than tall)
    var clipped = gy > seg.clip;
    if (clipped && cy - vh / 2 >= seg.clip) return;
    o.save();
    if (clipped) {
      o.beginPath();
      o.rect(0, 0, LW, seg.clip);
      o.clip();
    }
    o.translate(Math.round(gx), Math.round(cy));
    o.transform(QC[qi], QS[qi], -QS[qi], QC[qi], 0, 0);
    it.draw(o, 0, Math.round(vh / 2), w, w * it.dh / it.dw, it.e);
    flipDir = 1;
    o.restore();
    if (it.stars && it.landed) drawStars(gx, y - vh * 0.5, Math.max(4, vw * 0.5));
  }

  // -- Scenery that was hit ----------------------------------------------------

  function crashSprite(seg, sp, hitSpeed) {
    var spec = SPRITES[sp.type];
    var dir = sp.offset >= 0 ? 1 : -1;                       // away from the road
    var z = seg.z1 + SEG_LEN * 0.5;
    var wx = sp.offset * ROAD_W;
    var vz = hitSpeed * 0.4 + 500;
    var spin = rsign() * rr(5, 8);
    var t = sp.type;

    if (!spec.small) {
      // Big things stay put: they wobble and shed debris from the side you hit
      sp.shake = 0.55;
      if (shaking.indexOf(sp) < 0) shaking.push(sp);
      wx -= dir * spec.w * spec.hit * 0.5;
      if (t === 'tree' || t === 'poplar') {
        spawnBits(16, z, wx, spec.h * 0.3, spec.h * 0.85,
          ['#2f8a3a', '#3da24a', '#4cb85a', '#6ad176', '#6b4423'],
          { spread: 2200, upLo: 0, upHi: 2500, g: 2600, lifeLo: 1.0, lifeHi: 1.7, vz: vz * 0.5 });
        sfxLeaves();
      } else {
        spawnBits(12, z, wx, 150, spec.h * 0.6,
          t === 'barn' ? ['#b3322a', '#8f241f', '#f3ecdc', '#5b4a47'] : ['#efe6d6', '#b5523b', '#e4d9c4'],
          { spread: 2800, upLo: 800, upHi: 3500, sizeLo: 60, sizeHi: 100, ar: 2.4, g: 7000, vz: vz * 0.5 });
        sfxPlanks();
        if (t === 'windmill') {                              // a sail snaps off
          addFly('part', z, wx, 1500, vz * 0.5, -dir * rr(500, 1500), rr(3500, 4500),
            { draw: drawSailPiece, e: sp, dw: 500, dh: 1200, bw: 500, bh: 1200, vq: spin, restQ: 1, life: 4 });
        }
      }
      return;
    }

    // Small things are knocked away: take them out of the segment so they
    // cannot be hit again; updateScenery() puts them back after you pass.
    seg.sprites.splice(seg.sprites.indexOf(sp), 1);
    felled.push({ seg: seg, sp: sp });
    var vx = dir * rr(2200, 3200);

    if (t === 'hay') {
      spawnBits(8, z, wx, 100, 400, STRAW, { dir: dir, spread: 2200, upLo: 1200, upHi: 3500, sizeLo: 60, sizeHi: 110, g: 2200, lifeLo: 1.0, lifeHi: 1.8 });
      addFly('part', z, wx, 100, vz, vx, rr(2800, 3600),
        { draw: spec.draw, e: sp, dw: spec.w, dh: spec.h, bw: spec.w, bh: spec.h, vq: spin, bounces: 0, land: 'straw', life: 3 });
    } else if (t === 'sign') {
      sfxSnap();
      spawnBits(5, z, wx, 300, 800, ['#9aa0a8', '#f4f4f4', '#1d5fc1'], { dir: dir, spread: 2000, upLo: 1000, upHi: 3000 });
      addFly('part', z, wx, 600, vz, vx, rr(3500, 4500),
        { draw: drawSignBoard, e: sp, dw: 380, dh: 400, bw: 380, bh: 400, vq: spin, restQ: 1, life: 3.5 });
      addFly('part', z, wx, 200, vz, dir * rr(800, 1800), rr(2500, 3500),
        { draw: drawSignPole, e: sp, dw: 60, dh: 600, bw: 60, bh: 600, vq: -spin * 0.7, restQ: 3, life: 3.5 });
    } else if (t === 'cow') {
      // Tumbles head over hooves, lands on its feet, unhurt
      puff(z, wx, 100, WOOL, 4);
      addFly('part', z, wx, 100, vz, vx, rr(3600, 4400),
        { draw: spec.draw, e: sp, dw: spec.w, dh: spec.h, bw: spec.w, bh: spec.h, vq: spin * 0.6, bounces: 2, rest: 0.4, land: 'moo', poof: WOOL, life: 4.5 });
    }
  }

  // Shake timers and putting knocked-away scenery back once you are past it
  function updateScenery(dt) {
    var i;
    for (i = shaking.length - 1; i >= 0; i--) {
      shaking[i].shake -= dt;
      if (shaking[i].shake <= 0) { shaking[i].shake = 0; shaking.splice(i, 1); }
    }
    var pz = mod(position + PLAYER_Z, trackLength);
    for (i = felled.length - 1; i >= 0; i--) {
      if (wrapDz(felled[i].seg.z1 - pz) < -SEG_LEN * 20) {   // behind you, out of sight
        felled[i].seg.sprites.push(felled[i].sp);
        felled.splice(i, 1);
      }
    }
  }

  function restoreScenery() {
    var i;
    for (i = 0; i < felled.length; i++) felled[i].seg.sprites.push(felled[i].sp);
    felled.length = 0;
    for (i = 0; i < shaking.length; i++) shaking[i].shake = 0;
    shaking.length = 0;
  }

  // -- Traffic that was hit ------------------------------------------------------

  // Visual size of the whole drawing, in world units (a bit different from the
  // collision size in CAR_TYPES): used to place the tumbling box on the ground
  var CAR_LOOK = {
    tractor: { w: 400, h: 450 },
    wagon:   { w: 520, h: 630 },
    sheep:   { w: 560, h: 170 }
  };

  function crashCar(car, hitSpeed) {
    var spec = CAR_TYPES[car.type];
    var seg = findSegment(car.z);
    var at = seg.cars.indexOf(car);
    if (at >= 0) seg.cars.splice(at, 1);       // off the road for good (until it respawns)
    car.dead = true;
    car.respawn = 6 + Math.random() * 4;

    var t = car.type;
    var dir = car.offset >= playerX ? 1 : -1;  // knocked away from the player
    var wx = car.offset * ROAD_W;
    var vz = hitSpeed * 0.4 + 600;
    var vh = rr(2800, 3500);
    var air = 2 * vh / G_WORLD;
    var vx = (dir * rr(1.6, 2.4) * ROAD_W - wx) / air * 0.85;   // lands on the grass beside the road
    var spin = rsign() * rr(5, 8);
    var look = CAR_LOOK[t];
    var col = TRACTOR_COLORS[car.v % TRACTOR_COLORS.length];

    if (t === 'bike') {
      sfxClang();
      addFly('part', car.z, wx, 60, vz, vx, vh,
        { draw: drawBikeWreck, e: car, dw: 190, dh: 330, bw: 140, bh: 270, vq: spin, restQ: rsign() > 0 ? 1 : 3, bounces: 2, life: 5 });
      addFly('part', car.z, wx, 250, vz * 0.8, vx * 0.6 + dir * 500, vh * 1.3,
        { draw: drawRider, e: { sit: false }, sit: true, stars: true, dw: 190, dh: 330, bw: 170, bh: 370,
          vq: -spin * 0.7, restQ: 0, bounces: 1, rest: 0.3, poof: WOOL, life: 5.5 });
      spawnBits(4, car.z, wx, 100, 400, ['#9aa0a8', '#202020', '#e8553b'], { dir: dir, spread: 2000 });
    } else if (t === 'sheep') {
      sfxBaa();
      spawnBits(12, car.z, wx, 100, 300, WOOL, { dir: dir, spread: 2500, upLo: 1500, upHi: 4000, sizeLo: 80, sizeHi: 140, g: 2500, lifeLo: 0.8, lifeHi: 1.6 });
      addFly('part', car.z, wx, 60, vz, vx * 0.7, vh,
        { draw: drawSheep, e: car, dw: spec.w, dh: spec.h, bw: look.w, bh: look.h, vq: spin * 0.6, restQ: 0, bounces: 3, rest: 0.5, land: 'baa', poof: WOOL, life: 3.5 });
    } else {
      // Tractor or hay wagon: body chunks, a wheel that bounces away and smoke
      sfxClang();
      addFly('part', car.z, wx, 80, vz, vx, vh,
        { draw: CAR_DRAW[t], e: car, dw: spec.w, dh: spec.h, bw: look.w, bh: look.h, vq: spin, restQ: rsign() > 0 ? 1 : 3, bounces: 2, life: 6 });
      var wd = t === 'wagon' ? 150 : 190;
      addFly('part', car.z, wx, 150, vz * 0.8, dir * rr(2500, 4500), rr(3500, 4800),
        { draw: drawWheelPart, e: { rim: col.rim }, dw: wd, dh: wd, bw: wd, bh: wd, vq: dir * rr(6, 10), roll: true, bounces: 3, rest: 0.6, life: 5.5 });
      spawnBits(9, car.z, wx, 150, 500, [col.body, col.dark, '#202020', col.rim],
        { dir: dir, spread: 3500, upLo: 1500, upHi: 4500, sizeLo: 50, sizeHi: 95, vz: vz * 0.5 });
      puff(car.z, wx, 250, SMOKE_GREY, 4);
      if (t === 'wagon') {
        spawnBits(14, car.z, wx, 300, 700, STRAW,
          { dir: dir, spread: 3000, upLo: 2000, upHi: 5000, sizeLo: 70, sizeHi: 120, g: 2200, lifeLo: 1.2, lifeHi: 2.0 });
      }
    }
  }

  // A knocked-out vehicle comes back later, far down the road and out of view
  function respawnCar(car) {
    var pz = mod(position + PLAYER_Z, trackLength);
    car.z = mod(pz + (DRAW_DIST + 25 + Math.random() * 250) * SEG_LEN, trackLength);
    car.dead = false;
    car.bumped = 0;
    car.prevDz = wrapDz(car.z - pz);
    findSegment(car.z).cars.push(car);
  }

  // ---- The time-up explosion ---------------------------------------------------
  // The tractor never moves on screen, so this is done in screen space (low-res
  // pixels): a fireball, flying pieces (cab, hood, two wheels), the driver and
  // his straw hat, and fire / smoke particles.

  var PLAYER_COL = { body: '#2f9e44', dark: '#1f6b2e', rim: '#e8d36a' };
  var SCORCHED = { body: '#2f4a33', dark: '#1a2b1d', rim: '#8a7a3a' };

  function addFx(b, kind, x, y, vx, vy, life, size, grow) {
    if (b.fx.length >= FX_MAX) return;
    b.fx.push({ kind: kind, x: x, y: y, vx: vx, vy: vy, life: life, max: life, size: size, grow: grow });
  }

  // A tractor piece: centre (ccx, ccy) and size (w, h) in design units
  function boomPiece(b, name, ccx, ccy, w, h, vx, vy, vq, restQ) {
    var s = PLAYER_S;
    return {
      name: name, ccx: ccx, ccy: ccy,
      x: b.cx + ccx * s, y: b.by + ccy * s, vx: vx, vy: vy, q: 0, vq: vq, restQ: restQ,
      hv: h * s / 2, hh: w * s / 2, gy: b.by + rr(1, 6),
      bounces: 2, rest: 0.35, landed: false, roll: false
    };
  }

  function startBoom() {
    var s = PLAYER_S;
    var b = {
      t: 0, cx: LW / 2 + playerOffsetPx(), by: PLAYER_BY - Math.round(bounce),
      parts: [], fx: [], flameT: 0, smokeT: 0, driver: null, hat: null
    };
    boom = b;
    var fy = b.by - 28 * s;                                  // centre of the fireball
    var dir = rsign();

    b.parts.push(boomPiece(b, 'cab', 0, -45.5, 26, 43, dir * rr(25, 45), -rr(130, 160), dir * rr(3, 5), dir > 0 ? 1 : 3));
    b.parts.push(boomPiece(b, 'hood', 0, -19.5, 58, 21, -dir * rr(25, 45), -rr(105, 135), -dir * rr(3, 5), 2));
    for (var w = 0; w < 2; w++) {                            // both big rear wheels
      var side = w === 0 ? -1 : 1;
      var wp = boomPiece(b, 'wheel', side * 21.5, -13.5, 27, 27, side * rr(45, 75), -rr(110, 150), side * rr(6, 9), 0);
      wp.bounces = 3;
      wp.rest = 0.55;
      wp.roll = true;
      b.parts.push(wp);
    }

    // The driver is launched straight up, cartoon style, and lands sitting
    b.driver = {
      x: b.cx, y: b.by - 38 * s, vx: rr(-18, 18), vy: -175, q: 0, vq: rsign() * rr(3, 5), restQ: 0,
      hv: 10, hh: 6, gy: b.by + 3, bounces: 1, rest: 0.3, landed: false, roll: false
    };
    // ... and his straw hat floats down after him
    b.hat = { x: b.cx, y: b.by - 45 * s, vx: rr(-25, 25), vy: -150, t: 0, landed: false };

    // The first burst: fire, smoke and a few sparks
    var i, a, sp;
    for (i = 0; i < 34; i++) {
      a = rr(0, 6.283);
      sp = rr(25, 110);
      addFx(b, 'fire', b.cx + Math.cos(a) * 6, fy + Math.sin(a) * 4, Math.cos(a) * sp, Math.sin(a) * sp * 0.8 - 20, rr(0.35, 0.8), rr(3, 6), 0);
    }
    for (i = 0; i < 12; i++) {
      a = rr(0, 6.283);
      sp = rr(10, 50);
      addFx(b, 'smoke', b.cx + Math.cos(a) * 8, fy + Math.sin(a) * 6, Math.cos(a) * sp, Math.sin(a) * sp - 10, rr(1.2, 2), rr(5, 8), 5);
    }
    for (i = 0; i < 12; i++) {
      a = rr(0, 6.283);
      sp = rr(70, 170);
      addFx(b, 'ember', b.cx, fy, Math.cos(a) * sp, Math.sin(a) * sp - 60, rr(0.4, 0.8), 1, 0);
    }
    if (!reduceMotion) shakeT = 0.5;
  }

  // Move one flying piece (or the driver): gravity, bounces, then rest
  function stepBody(p, dt) {
    if (p.landed && !p.roll) return;
    if (!p.landed) {
      p.vy += BOOM_G * dt;
      p.y += p.vy * dt;
      p.q += p.vq * dt;
      var half = (Math.floor(p.q) & 1) ? p.hh : p.hv;
      if (p.y + half >= p.gy && p.vy > 0) {
        p.y = p.gy - half;
        if (p.bounces > 0 && p.vy > 25) {
          p.vy = -p.vy * p.rest;
          p.vx *= 0.75;
          p.vq *= 0.6;
          p.bounces--;
        } else {
          p.landed = true;
          p.vy = 0;
          if (!p.roll) {                                     // settle in its resting pose
            p.vx = 0;
            p.vq = 0;
            p.q = p.restQ;
            p.y = p.gy - ((p.restQ & 1) ? p.hh : p.hv);
          }
        }
      }
    } else {
      p.vx *= Math.max(0, 1 - 1.4 * dt);                     // rolling wheel slows down
      p.q += p.vx * dt / 15;
    }
    p.x += p.vx * dt;
  }

  function updateHat(b, dt) {
    var h = b.hat;
    var d = b.driver;
    if (h.landed) return;
    h.t += dt;
    h.vy = Math.min(h.vy + 150 * dt, 38);                    // floats: slow terminal speed
    h.vx *= Math.max(0, 1 - 1.5 * dt);
    h.x += h.vx * dt;
    h.y += h.vy * dt;
    if (h.vy > 0) h.x += (d.x - h.x) * 1.2 * dt + Math.sin(h.t * 6) * 18 * dt;   // sway toward the driver
    var landY = d.landed ? d.gy - 16 : b.by + 4;             // onto his head
    if (h.vy > 0 && h.y >= landY) {
      h.y = landY;
      h.landed = true;
      if (d.landed) h.x = d.x + 1;
    }
  }

  function updateBoom(dt) {
    if (!boom) return;
    var b = boom;
    var i;
    b.t += dt;
    for (i = 0; i < b.parts.length; i++) stepBody(b.parts[i], dt);
    stepBody(b.driver, dt);
    updateHat(b, dt);

    // Lingering: smoke column and small flames on the wreck
    if (b.t > 0.45) {
      b.smokeT -= dt;
      if (b.smokeT <= 0) {
        b.smokeT = 0.09;
        var cabP = b.parts[0];
        var fromCab = Math.random() < 0.4;
        addFx(b, 'smoke', (fromCab ? cabP.x : b.cx) + rr(-4, 4), (fromCab ? cabP.y : b.by - 14), rr(-4, 4), -rr(16, 26), 1.9, 3, 5);
      }
      b.flameT -= dt;
      if (b.flameT <= 0) {
        b.flameT = 0.07;
        var src = Math.random() < 0.4 ? b.parts[Math.floor(Math.random() * 2)] : null;   // cab, hood or the chassis
        addFx(b, 'fire', (src ? src.x : b.cx) + rr(-6, 6), (src ? src.y - src.hv * 0.5 : b.by - 12), rr(-4, 4), -rr(18, 34), rr(0.25, 0.5), rr(2, 3.5), 0);
      }
    }

    for (i = b.fx.length - 1; i >= 0; i--) {
      var f = b.fx[i];
      f.life -= dt;
      if (f.life <= 0) { b.fx.splice(i, 1); continue; }
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vx *= Math.max(0, 1 - 1.2 * dt);
      if (f.kind === 'ember') f.vy += 250 * dt;
      else f.vy -= (f.kind === 'fire' ? 30 : 12) * dt;       // hot air rises
      f.size += f.grow * dt;
    }
  }

  // -- Drawing the explosion ---------------------------------------------------

  // Run fn with the origin at (x, y) and the picture turned by whole quarters
  function drawTurned(x, y, q, fn) {
    var qi = mod(Math.floor(q), 4);
    o.save();
    o.translate(Math.round(x), Math.round(y));
    o.transform(QC[qi], QS[qi], -QS[qi], QC[qi], 0, 0);
    fn();
    o.restore();
  }

  function drawFireball(b) {
    var u = b.t / 1.3;
    if (u >= 1) return;
    var grow = Math.min(1, b.t / 0.3);
    var R = 8 + 24 * (1 - (1 - grow) * (1 - grow)) + u * 4;
    var cx = b.cx;
    var cy = b.by - 28 * PLAYER_S;
    o.globalAlpha = u > 0.7 ? 1 - (u - 0.7) / 0.3 : 1;
    // red outer cloud (several overlapping discs), then orange, then a hot core
    var outer = u < 0.45 ? '#e8431a' : (u < 0.7 ? '#8c2a16' : '#3b3535');
    pixelDisc(o, cx, cy, R, outer);
    pixelDisc(o, cx - R * 0.45, cy - R * 0.3, R * 0.6, outer);
    pixelDisc(o, cx + R * 0.5, cy - R * 0.2, R * 0.55, outer);
    pixelDisc(o, cx, cy - R * 0.6, R * 0.5, outer);
    if (u < 0.6) pixelDisc(o, cx, cy - 2, R * 0.72 * (1 - u / 0.75), '#ff9a1f');
    if (u < 0.4) pixelDisc(o, cx, cy - 3, R * 0.42 * (1 - u / 0.45), '#fff27a');
    if (u < 0.1) pixelDisc(o, cx, cy - 3, R * 0.3, '#ffffff');
    o.globalAlpha = 1;
  }

  function drawDriverPx(g, x, by, sit) {
    x = Math.round(x);
    by = Math.round(by);
    function R(ax, ay, aw, ah, col) {
      g.fillStyle = col;
      g.fillRect(x + ax, by + ay, aw, ah);
    }
    if (sit) {                                               // sitting on the road, dazed
      R(-7, -3, 6, 3, '#1f4a8a');                            // legs
      R(1, -3, 6, 3, '#1f4a8a');
      R(-5, -10, 10, 7, '#2a63b8');                          // overalls
      R(-8, -9, 3, 6, '#d9d2c0');                            // arms
      R(5, -9, 3, 6, '#d9d2c0');
      R(-4, -17, 8, 7, '#f2c49b');                           // head
      R(-4, -18, 8, 2, '#7a4a22');                           // hair
      R(-3, -15, 2, 2, '#222222');                           // dizzy eyes
      R(1, -15, 2, 2, '#222222');
      R(-1, -12, 3, 1, '#a03030');                           // mouth
    } else {                                                 // flying, arms flailing
      var flap = Math.floor(time * 10) % 2;
      R(-4, -5, 3, 5, '#1f4a8a');
      R(1, -5, 3, 5, '#1f4a8a');
      R(-5, -13, 10, 8, '#2a63b8');
      R(-8, flap ? -20 : -12, 3, 7, '#d9d2c0');
      R(5, flap ? -12 : -20, 3, 7, '#d9d2c0');
      R(-3, -20, 7, 7, '#f2c49b');
      R(-3, -21, 7, 2, '#7a4a22');
    }
  }

  function drawHatPx(x, y) {
    x = Math.round(x);
    y = Math.round(y);
    o.fillStyle = '#f5d142';
    o.fillRect(x - 5, y - 1, 11, 2);                         // brim
    o.fillStyle = '#e8c52e';
    o.fillRect(x - 3, y - 4, 7, 3);                          // crown
    o.fillStyle = '#a8431f';
    o.fillRect(x - 3, y - 2, 7, 1);                          // band
  }

  function drawWreck() {
    var b = boom;
    var s = PLAYER_S;
    var pal = b.t < 0.2 ? PLAYER_COL : SCORCHED;
    var i;

    // Scorch mark on the road
    o.fillStyle = 'rgba(0,0,0,0.22)';
    o.fillRect(b.cx - 30, b.by - 1, 60, 4);
    o.fillRect(b.cx - 24, b.by - 3, 48, 2);
    o.fillRect(b.cx - 24, b.by + 3, 48, 1);

    drawFireball(b);

    // What is left standing: front wheels and a charred frame
    drawTractor(o, b.cx, b.by, s, SCORCHED, 0, 0, 'base');
    o.fillStyle = '#2b2624';
    o.fillRect(Math.round(b.cx - 14 * s), Math.round(b.by - 14 * s), Math.round(28 * s), Math.max(2, Math.round(6 * s)));
    o.fillStyle = '#4a3a2a';
    o.fillRect(Math.round(b.cx - 14 * s), Math.round(b.by - 14 * s), Math.round(28 * s), 1);

    // Flying pieces
    for (i = 0; i < b.parts.length; i++) {
      var p = b.parts[i];
      if (p.name === 'wheel') {
        drawTurned(p.x, p.y, p.q, function () { drawDiscWheel(o, 0, 0, p.hv * 2, pal.rim); });
      } else {
        drawTurned(p.x, p.y, p.q, function () {
          drawTractor(o, -p.ccx * s, -p.ccy * s, s, pal, 0, 0, p.name);
        });
      }
    }

    // The driver (lands sitting, dazed, with stars) and his hat
    var d = b.driver;
    drawTurned(d.x, d.y, d.q, function () { drawDriverPx(o, 0, d.hv, d.landed); });
    if (d.landed) drawStars(d.x, d.gy - 21, 7);
    drawHatPx(b.hat.x, b.hat.y);

    // Smoke first, then flames and sparks on top
    var f, sz;
    for (i = 0; i < b.fx.length; i++) {
      f = b.fx[i];
      if (f.kind !== 'smoke') continue;
      var fr = f.life / f.max;
      o.globalAlpha = clamp(fr * 0.8, 0, 0.65);
      o.fillStyle = fr > 0.5 ? '#3a3636' : '#555050';
      sz = Math.max(1, Math.round(f.size));
      o.fillRect(Math.round(f.x - sz / 2), Math.round(f.y - sz / 2), sz, sz);
    }
    o.globalAlpha = 1;
    for (i = 0; i < b.fx.length; i++) {
      f = b.fx[i];
      if (f.kind === 'smoke') continue;
      if (f.kind === 'ember') {
        o.fillStyle = f.life > f.max * 0.4 ? '#fff2a0' : '#ffb03a';
        o.fillRect(Math.round(f.x), Math.round(f.y), 1, 1);
        continue;
      }
      var k = f.life / f.max;                                // flame colour cools as it ages
      o.fillStyle = k > 0.7 ? '#fff3a0' : (k > 0.45 ? '#ffc83a' : (k > 0.25 ? '#ff7a1a' : (k > 0.1 ? '#d8301a' : '#4a4040')));
      sz = Math.max(1, Math.round(f.size * (0.3 + 0.7 * k)));
      o.fillRect(Math.round(f.x - sz / 2), Math.round(f.y - sz / 2), sz, sz);
    }
  }

  // ---- Messages and popups ----------------------------------------------

  var messageSub = '';

  function setMessage(text, sub, seconds) {
    message = text;
    messageSub = sub;
    messageT = seconds;
  }

  function addPopup(text) {
    popups.push({ text: text, t: 1.2 });
  }

  // ---- Update ------------------------------------------------------------

  function update(dt) {
    time += dt;
    updateParticles(dt);
    updateFly(dt);
    updateBoom(dt);
    updateScenery(dt);
    messageT = Math.max(0, messageT - dt);
    hitCooldown = Math.max(0, hitCooldown - dt);
    shakeT = Math.max(0, shakeT - dt);
    for (var i = popups.length - 1; i >= 0; i--) {
      popups[i].t -= dt;
      if (popups[i].t <= 0) popups.splice(i, 1);
    }

    var gas = state === 'racing' && (keys.up || touch.up);
    throttle = approach(throttle, gas ? 1 : 0, dt * 5);

    if (state === 'title') {
      updateTitle(dt);
    } else if (state === 'racing') {
      updateRacing(dt, gas);
    } else {
      updateOver(dt);
    }

    updateEngine();
  }

  // Advance position and animate the scenery (shared by all states)
  function advance(dt) {
    var oldPos = position;
    var seg = findSegment(position + PLAYER_Z);
    position = mod(position + dt * speed, trackLength);
    distance += dt * speed;
    wheelPhase += dt * speed / 150;
    var moved = (dt * speed) / SEG_LEN;
    bg[0] += seg.curve * moved * 0.05 + dt * 2.5;
    bg[1] += seg.curve * moved * 0.18;
    bg[2] += seg.curve * moved * 0.45;
    updateCars(dt);
    return oldPos;
  }

  function updateTitle(dt) {
    speed = MAX_SPEED * 0.5;
    playerX = 0.35 * Math.sin(time * 0.4);
    steerVis = Math.cos(time * 0.4) * 0.3;
    shakeMag = 0;
    bounce = 0;
    advance(dt);
  }

  function updateOver(dt) {
    overTime += dt;                    // starts below 0: the panel waits for the explosion
    speed = Math.max(0, speed - MAX_SPEED * 6 * dt);   // the road stops almost at once
    throttle = 0;
    steerVis = approach(steerVis, 0, dt * 4);
    shakeMag = 0;
    advance(dt);
  }

  function updateRacing(dt, gas) {
    var sp = speed / MAX_SPEED;
    var seg = findSegment(position + PLAYER_Z);

    // Steering (needs some speed to turn) and the curve pushing you outward
    var steerDir = (keys.right || touch.right ? 1 : 0) - (keys.left || touch.left ? 1 : 0);
    var steerPower = dt * STEER * (0.35 + 0.65 * sp) * Math.min(1, speed / (MAX_SPEED * 0.1));
    playerX += steerDir * steerPower;
    playerX -= dt * 2 * sp * sp * seg.curve * CENTRIFUGAL;
    steerVis = approach(steerVis, steerDir - seg.curve * sp * 0.12, dt * 6);
    steerVis = clamp(steerVis, -1, 1);

    // Pedals
    if (gas) speed += ACCEL * dt;
    else if (keys.down || touch.down) speed += BRAKE * dt;
    else speed += COAST * dt;

    // Grass: big slowdown, shaking and bumping
    var offroad = Math.abs(playerX) > 1;
    if (offroad && speed > OFFROAD_LIMIT) speed += OFFROAD_DECEL * dt;
    speed = clamp(speed, 0, MAX_SPEED);
    playerX = clamp(playerX, -2.2, 2.2);

    shakeMag = offroad ? clamp(sp * 1.6, 0, 1.6) : 0;
    bounce = offroad && !reduceMotion ? (Math.random() < 0.5 ? 0 : 1) * sp * 2 : 0;

    var prevPos = position;
    advance(dt);

    // Clock
    timeLeft -= dt;
    var whole = Math.ceil(timeLeft);
    if (timeLeft > 0 && whole <= 5 && whole !== lastBeep) {
      lastBeep = whole;
      sfxBeep();
    }

    checkSprites(prevPos);
    checkCars();
    checkCheckpoint(prevPos);

    // Smoke from the exhaust: more when you give it gas
    smokeAcc += dt * (3 + 16 * throttle);
    while (smokeAcc >= 1) {
      smokeAcc -= 1;
      addSmoke(LW / 2 + playerOffsetPx() + (9.5 + Math.round(steerVis * 3)) * PLAYER_S,
        PLAYER_BY - 66 * PLAYER_S - bounce);
    }

    if (timeLeft <= 0) endGame();
  }

  function endGame() {
    timeLeft = 0;
    state = 'over';
    overTime = -BOOM_PANEL_DELAY;     // restart delay counts from when the panel appears
    var s = score();
    if (s > best) {
      best = s;
      newBest = true;
      saveBest();
    }
    setMessage('', '', 0);
    stopEngine();
    startBoom();
    sfxBoom();
    sfxTimeUp();
  }

  // Hitting scenery stops you dead and bounces you back
  function checkSprites(prevPos) {
    if (hitCooldown > 0) return;
    var from = Math.floor(mod(prevPos + PLAYER_Z, trackLength) / SEG_LEN);
    var to = Math.floor(mod(position + PLAYER_Z, trackLength) / SEG_LEN);
    if (to < from) to += N;
    if (to - from > 6) from = to;
    for (var i = from; i <= to; i++) {
      var seg = segments[i % N];
      for (var k = 0; k < seg.sprites.length; k++) {
        var sp = seg.sprites[k];
        var spec = SPRITES[sp.type];
        if (!spec.solid) continue;
        var hw = spec.w / ROAD_W / 2 * spec.hit;
        if (Math.abs(playerX - sp.offset) < PLAYER_HW + hw) {
          var hitSpeed = speed;
          speed = 0;
          position = mod(position - 500, trackLength);
          // Slide to the side of the obstacle that faces the road
          playerX = sp.offset - (sp.offset >= 0 ? 1 : -1) * (PLAYER_HW + hw + 0.05);
          playerX = clamp(playerX, -2.2, 2.2);
          hitCooldown = 0.6;
          if (!reduceMotion) { shakeT = 0.4; }
          sfxCrash();
          crashSprite(seg, sp, hitSpeed);
          return;
        }
      }
    }
  }

  // Bumping slower traffic costs lots of speed; passing it scores points
  function checkCars() {
    var pz = mod(position + PLAYER_Z, trackLength);
    for (var i = 0; i < cars.length; i++) {
      var car = cars[i];
      if (car.dead) continue;
      var dz = wrapDz(car.z - pz);
      var overlapX = Math.abs(playerX - car.offset) < PLAYER_HW + car.hw;

      if (hitCooldown <= 0 && overlapX && dz > -150 && dz < 260 && speed > car.speed) {
        var hitSpeed = speed;
        speed = Math.min(speed * 0.3, car.speed * 0.6);
        playerX += (playerX >= car.offset ? 1 : -1) * 0.22;
        playerX = clamp(playerX, -2.2, 2.2);
        hitCooldown = 0.6;
        if (!reduceMotion) shakeT = 0.3;
        sfxBump();
        car.bumped = 1;
        crashCar(car, hitSpeed);
      } else if (car.prevDz > 0 && dz <= 0 && dz > -SEG_LEN * 4 && !car.bumped) {
        bonusScore += OVERTAKE_POINTS;
        addPopup('+' + OVERTAKE_POINTS);
      }
      if (dz > SEG_LEN * 6) car.bumped = 0;
      car.prevDz = dz;
    }
  }

  // Driving through a banner adds time
  function checkCheckpoint(prevPos) {
    var from = Math.floor(mod(prevPos + PLAYER_Z, trackLength) / SEG_LEN);
    var to = Math.floor(mod(position + PLAYER_Z, trackLength) / SEG_LEN);
    if (to < from && from - to > N / 2) { lap++; to += N; }   // crossed the lap line
    else if (to < from) return;                               // bounced backwards
    for (var i = from + 1; i <= to; i++) {
      if (segments[i % N].cp) {
        var key = lap * N + i;
        if (key > lastCpKey) {
          lastCpKey = key;
          cpCount++;
          var bonus = Math.max(BONUS_MIN, BONUS_FIRST - (cpCount - 1) * BONUS_STEP);
          timeLeft += bonus;
          lastBeep = -1;
          setMessage('EXTENDED PLAY!', '+' + bonus + ' SEC', 2.4);
          sfxCheckpoint();
        }
      }
    }
  }

  // ---- Pre-rendered backgrounds ----------------------------------------

  var TW = 480;                // width of a repeating background layer

  function skyColor(t) {
    // hard bands from deep blue (top) to pale blue (horizon)
    var a = [58, 150, 255];
    var b = [196, 232, 255];
    return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' +
      Math.round(lerp(a[1], b[1], t)) + ',' + Math.round(lerp(a[2], b[2], t)) + ')';
  }

  var skyLayer = (function () {
    var c = makeCanvas(LW, HORIZON + 1);
    var g = c.getContext('2d');
    var band = 6;
    for (var y = 0; y <= HORIZON; y += band) {
      g.fillStyle = skyColor(Math.min(1, y / HORIZON));
      g.fillRect(0, y, LW, band);
    }
    // The sun
    g.fillStyle = 'rgba(255, 255, 255, 0.35)';
    g.fillRect(177, 17, 26, 26);
    g.fillRect(180, 14, 20, 32);
    g.fillRect(174, 20, 32, 20);
    g.fillStyle = '#fff6b8';
    g.fillRect(181, 20, 18, 20);
    g.fillRect(184, 17, 12, 26);
    g.fillRect(178, 23, 24, 14);
    return c;
  })();

  function pixelCloud(g, x, y, w) {
    g.fillStyle = '#ffffff';
    g.fillRect(x + 2, y + 4, w - 4, 5);
    g.fillRect(x, y + 6, w, 3);
    g.fillRect(x + Math.round(w * 0.15), y + 1, Math.round(w * 0.4), 6);
    g.fillRect(x + Math.round(w * 0.4), y - 2, Math.round(w * 0.3), 8);
    g.fillStyle = '#dcefff';
    g.fillRect(x + 2, y + 8, w - 4, 2);
  }

  var cloudLayer = (function () {
    var c = makeCanvas(TW, 56);
    var g = c.getContext('2d');
    for (var i = 0; i < 7; i++) {
      pixelCloud(g, Math.round((i + rnd() * 0.5) * TW / 7), 8 + Math.floor(rnd() * 34), 22 + Math.floor(rnd() * 22));
    }
    return c;
  })();

  // Rolling hills that tile horizontally (all waves have a whole number of
  // cycles per tile, so the edges match)
  function hillHeight(x, base, a1, a2, a3) {
    var k = Math.PI * 2 / TW;
    return base + a1 * Math.sin(x * k * 2 + 0.5) + a2 * Math.sin(x * k * 5 + 2) + a3 * Math.sin(x * k * 11 + 1);
  }

  var LAYER_H = 44;

  var farLayer = (function () {
    var c = makeCanvas(TW, LAYER_H);
    var g = c.getContext('2d');
    for (var x = 0; x < TW; x++) {
      var h = Math.round(hillHeight(x, 14, 5, 3, 1.5));
      g.fillStyle = '#a4d8b8';
      g.fillRect(x, LAYER_H - h, 1, h);
      g.fillStyle = '#bfe6cc';
      g.fillRect(x, LAYER_H - h, 1, 1);
    }
    // A church tower and some farm roofs on the horizon
    var cx = 150;
    var top = LAYER_H - Math.round(hillHeight(cx, 14, 5, 3, 1.5));
    g.fillStyle = '#d8ccbc';
    g.fillRect(cx, top - 13, 4, 13);
    g.fillStyle = '#9a4b3a';
    g.fillRect(cx - 1, top - 16, 6, 3);
    g.fillRect(cx, top - 19, 4, 3);
    g.fillRect(cx + 1, top - 22, 2, 3);
    for (var i = 0; i < 6; i++) {
      var hx = 40 + i * 75 + Math.floor(rnd() * 20);
      var ht = LAYER_H - Math.round(hillHeight(hx, 14, 5, 3, 1.5));
      g.fillStyle = '#e9e2d6';
      g.fillRect(hx, ht - 4, 7, 4);
      g.fillStyle = '#b5523b';
      g.fillRect(hx - 1, ht - 6, 9, 2);
    }
    return c;
  })();

  // Near hills with tree clumps and a few windmills (sails turn live)
  var nearMills = [];
  var nearLayer = (function () {
    var c = makeCanvas(TW, LAYER_H);
    var g = c.getContext('2d');
    var x;
    for (x = 0; x < TW; x++) {
      var h = Math.round(hillHeight(x, 11, 4, 2.5, 1.2));
      g.fillStyle = '#58b058';
      g.fillRect(x, LAYER_H - h, 1, h);
      g.fillStyle = '#74c86a';
      g.fillRect(x, LAYER_H - h, 1, 1);
    }
    // Dikes: thin pale lines
    g.fillStyle = '#8bd07c';
    g.fillRect(0, LAYER_H - 5, TW, 1);
    // Tree clumps
    for (var i = 0; i < 26; i++) {
      var tx = Math.floor(rnd() * TW);
      var ty = LAYER_H - Math.round(hillHeight(tx, 11, 4, 2.5, 1.2));
      g.fillStyle = '#2f8a3a';
      g.fillRect(tx, ty - 4, 5, 4);
      g.fillStyle = '#3da24a';
      g.fillRect(tx + 1, ty - 5, 3, 2);
    }
    // Windmills: body here, sails drawn each frame
    var mx = [60, 215, 360];
    for (var m = 0; m < mx.length; m++) {
      var by = LAYER_H - Math.round(hillHeight(mx[m], 11, 4, 2.5, 1.2)) + 1;
      g.fillStyle = '#b5523b';
      g.fillRect(mx[m] - 4, by - 2, 8, 2);
      g.fillStyle = '#efe6d6';
      g.fillRect(mx[m] - 3, by - 8, 6, 6);
      g.fillRect(mx[m] - 2, by - 14, 4, 6);
      g.fillStyle = '#8b3a2a';
      g.fillRect(mx[m] - 3, by - 16, 6, 2);
      nearMills.push({ x: mx[m], hubY: by - 15, phase: m * 1.7 });
    }
    return c;
  })();

  // Haze over the horizon so far-away scenery fades in softly
  var hazeLayer = (function () {
    var c = makeCanvas(LW, 14);
    var g = c.getContext('2d');
    for (var y = 0; y < 14; y++) {
      var a = 0.38 * (1 - Math.abs(y - 8) / 8);
      g.fillStyle = 'rgba(210, 238, 255, ' + Math.max(0, a).toFixed(3) + ')';
      g.fillRect(0, y, LW, 1);
    }
    return c;
  })();

  // ---- Drawing: road -----------------------------------------------------

  function polygon(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    o.fillStyle = color;
    o.beginPath();
    o.moveTo(x1, y1);
    o.lineTo(x2, y2);
    o.lineTo(x3, y3);
    o.lineTo(x4, y4);
    o.closePath();
    o.fill();
  }

  function renderSegment(seg) {
    var c = seg.light ? COL_LIGHT : COL_DARK;
    var x1 = seg.sx1, y1 = seg.sy1, w1 = seg.sw1;
    var x2 = seg.sx2, y2 = seg.sy2, w2 = seg.sw2;
    var r1 = w1 / Math.max(6, 2 * LANES);
    var r2 = w2 / Math.max(6, 2 * LANES);

    o.fillStyle = c.grass;
    o.fillRect(0, y2, LW, y1 - y2);

    polygon(x1 - w1 - r1, y1, x1 - w1, y1, x2 - w2, y2, x2 - w2 - r2, y2, c.rumble);
    polygon(x1 + w1 + r1, y1, x1 + w1, y1, x2 + w2, y2, x2 + w2 + r2, y2, c.rumble);
    polygon(x1 - w1, y1, x1 + w1, y1, x2 + w2, y2, x2 - w2, y2, c.road);

    if (c.lane) {
      var l1 = Math.max(0.6, w1 / 32);
      var l2 = Math.max(0.6, w2 / 32);
      var lw1 = w1 * 2 / LANES;
      var lw2 = w2 * 2 / LANES;
      var lx1 = x1 - w1 + lw1;
      var lx2 = x2 - w2 + lw2;
      for (var lane = 1; lane < LANES; lane++) {
        polygon(lx1 - l1 / 2, y1, lx1 + l1 / 2, y1, lx2 + l2 / 2, y2, lx2 - l2 / 2, y2, c.lane);
        lx1 += lw1;
        lx2 += lw2;
      }
    }
  }

  // Project one road edge to the screen
  function projectSeg(seg, camX, camY, camZ, which) {
    var y = which === 1 ? seg.y1 : seg.y2;
    var z = which === 1 ? seg.z1 : seg.z2;
    var cz = z - camZ;
    var scale = CAM_DEPTH / cz;
    var sx = Math.round(LW / 2 + scale * (-camX) * LW / 2);
    var sy = Math.round(HORIZON - scale * (y - camY) * LH / 2);
    var sw = Math.round(scale * ROAD_W * LW / 2);
    if (which === 1) {
      seg.cz = cz; seg.sc1 = scale; seg.sx1 = sx; seg.sy1 = sy; seg.sw1 = sw;
    } else {
      seg.sc2 = scale; seg.sx2 = sx; seg.sy2 = sy; seg.sw2 = sw;
    }
  }

  function playerOffsetPx() {
    return Math.round(steerVis * 3 * PLAYER_S);
  }

  // ---- Drawing: vehicles --------------------------------------------------

  // A tractor seen from behind. (cx, by) is the bottom centre, s the scale.
  // Design size is about 58 x 67 pixels at s = 1.
  function drawTractor(g, cx, by, s, c, lean, phase, part) {
    function R(x, y, w, h, col) {
      var x0 = Math.round(cx + x * s);
      var y0 = Math.round(by + y * s);
      var x1 = Math.round(cx + (x + w) * s);
      var y1 = Math.round(by + (y + h) * s);
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 <= y0) y1 = y0 + 1;
      g.fillStyle = col;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    var L = Math.round(lean * 3);
    // part: draw the whole tractor (undefined) or one piece of it, for the
    // time-up explosion: 'base' (front wheels), 'hood' (rear body + fenders)
    // or 'cab' (cab and exhaust, no driver). The big wheels are drawn
    // separately as discs when the tractor falls apart.
    var all = !part;

    if (all || part === 'base') {
      R(-26, -2, 52, 3, 'rgba(0,0,0,0.28)');                // shadow
      R(-12 + L * 0.3, -17, 5, 13, TIRE);                    // small front wheels
      R(7 + L * 0.3, -17, 5, 13, TIRE);
    }
    if (all || part === 'hood') {
      R(-14, -26, 28, 16, c.body);                           // rear body
      R(-14, -12, 28, 3, c.dark);
    }

    // Big rear wheels with tread bars that scroll with speed
    var wheels = [-28, 15];
    for (var w = 0; w < 2 && all; w++) {
      var wx = wheels[w];
      R(wx, -27, 13, 27, TIRE);
      for (var k = 0; k < 6; k++) {
        var ty = mod(k * 5 + Math.floor(phase), 27);
        if (ty > 25) ty = 25;
        R(wx, -27 + ty, 13, 2, TREAD);
      }
      R(w === 0 ? -17 : 15, -20, 2, 13, c.rim);              // rim, inner edge
    }
    if (all || part === 'hood') {
      R(-29, -30, 16, 4, c.dark);                            // fenders
      R(13, -30, 16, 4, c.dark);
      R(-12, -22, 3, 3, '#ff4a3a');                          // tail lights
      R(9, -22, 3, 3, '#ff4a3a');
    }

    // Cab, leaning a little into the steering direction
    if (all || part === 'cab') {
      R(-11 + L, -50, 22, 26, c.body);
      R(-9 + L, -47, 18, 16, '#bfe6ff');                     // glass
      R(-9 + L, -47, 18, 2, '#e8f6ff');
      R(-13 + L, -54, 26, 4, c.dark);                        // roof
      if (all) {
        R(-4 + L, -42, 8, 7, '#f2c49b');                     // driver: face ...
        R(-5 + L, -45, 10, 3, '#f5d142');                    // ... straw hat
        R(-7 + L, -35, 14, 5, '#2a63b8');                    // ... overalls
      }
      R(8 + L, -66, 3, 14, '#3b3b3b');                       // exhaust pipe
      R(7 + L, -67, 5, 2, '#222222');
    }
  }

  function drawWagonCar(g, x, y, w, h, e) {
    var s = w / 64;
    drawTractor(g, x, y - 20 * s, s * 0.85, TRACTOR_COLORS[e.v % TRACTOR_COLORS.length], 0, e.z / 40);
    function R(ax, ay, aw, ah, col) {
      var x0 = Math.round(x + ax * s);
      var y0 = Math.round(y + ay * s);
      var x1 = Math.round(x + (ax + aw) * s);
      var y1 = Math.round(y + (ay + ah) * s);
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 <= y0) y1 = y0 + 1;
      g.fillStyle = col;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    R(-32, -16, 7, 16, TIRE);                                // wagon wheels
    R(25, -16, 7, 16, TIRE);
    R(-32, -14 + (Math.floor(e.z / 40) % 4) * 3, 7, 2, TREAD);
    R(25, -14 + (Math.floor(e.z / 40) % 4) * 3, 7, 2, TREAD);
    R(-28, -24, 56, 14, '#a8743a');                          // bed
    R(-28, -12, 56, 3, '#7a5226');
    R(-28, -18, 56, 2, '#8a5d2c');
    R(-26, -34, 52, 10, '#e7c84f');                          // hay pile
    R(-26, -29, 52, 1, '#c9a63a');
    R(-22, -40, 44, 7, '#f0d65f');
    R(-14, -44, 28, 5, '#f6e27c');
  }

  function drawTractorCar(g, x, y, w, h, e) {
    drawTractor(g, x, y, w / 58, TRACTOR_COLORS[e.v % TRACTOR_COLORS.length], 0, e.z / 40);
  }

  function drawBike(g, x, y, w, h, e) {
    var s = w / 16;
    var step = Math.floor(e.z / 90) % 2;
    function R(ax, ay, aw, ah, col) {
      var x0 = Math.round(x + ax * s);
      var y0 = Math.round(y + ay * s);
      var x1 = Math.round(x + (ax + aw) * s);
      var y1 = Math.round(y + (ay + ah) * s);
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 <= y0) y1 = y0 + 1;
      g.fillStyle = col;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    R(-1, -14, 2, 14, '#202020');                            // rear wheel
    R(-4, -12 + step * 2, 2, 6, '#34495e');                  // legs
    R(2, -10 - step * 2, 2, 6, '#34495e');
    R(-4, -26, 8, 12, '#e8553b');                            // jacket
    R(-3, -32, 6, 6, '#f2c49b');                             // head
    R(-3, -34, 6, 3, '#f5d142');                             // helmet
    R(-7, -24, 3, 8, '#e8553b');                             // arms
    R(4, -24, 3, 8, '#e8553b');
    R(-7, -25, 14, 1, '#202020');                            // handlebar
  }

  function drawSheep(g, x, y, w, h, e) {
    var s = w / 48;
    var bob = Math.floor(e.z / 120 + time * 3) % 2;
    function R(ax, ay, aw, ah, col) {
      var x0 = Math.round(x + ax * s);
      var y0 = Math.round(y + ay * s);
      var x1 = Math.round(x + (ax + aw) * s);
      var y1 = Math.round(y + (ay + ah) * s);
      if (x1 <= x0) x1 = x0 + 1;
      if (y1 <= y0) y1 = y0 + 1;
      g.fillStyle = col;
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
    }
    for (var i = 0; i < 3; i++) {
      var sx = -24 + i * 16;
      var up = (i + bob) % 2;
      R(sx + 1, -3, 2, 3, '#333333');                        // legs
      R(sx + 9, -3, 2, 3, '#333333');
      R(sx, -12 - up, 13, 9, '#f2f2f2');                     // wool
      R(sx + 2, -14 - up, 9, 3, '#ffffff');
      R(sx + 4, -8 - up, 5, 3, '#cfcfcf');
      R(sx - 1, -11 - up, 3, 4, '#222222');                  // head
    }
  }

  var CAR_DRAW = {
    tractor: drawTractorCar,
    wagon: drawWagonCar,
    bike: drawBike,
    sheep: drawSheep
  };

  // ---- Drawing: scene ---------------------------------------------------------

  function drawSpriteAt(fn, x, y, w, h, clipY, extra) {
    if (w < 1.5) return;
    if (x + w * 0.8 < 0 || x - w * 0.8 > LW) return;
    var clipped = y > clipY;
    if (clipped) {
      if (y - h >= clipY) return;
      o.save();
      o.beginPath();
      o.rect(0, 0, LW, clipY);
      o.clip();
    }
    flipDir = (extra && extra.flip) || 1;
    fn(o, x, y, w, h, extra);
    flipDir = 1;
    if (clipped) o.restore();
  }

  function drawLayer(img, scroll, y) {
    var x = -mod(Math.round(scroll), TW);
    o.drawImage(img, x, y);
    o.drawImage(img, x + TW, y);
  }

  function drawBackground() {
    o.drawImage(skyLayer, 0, 0);
    drawLayer(cloudLayer, bg[0], 4);
    drawLayer(farLayer, bg[1], HORIZON - LAYER_H);
    drawLayer(nearLayer, bg[2], HORIZON - LAYER_H);

    // Turning sails on the near windmills
    var shift = -mod(Math.round(bg[2]), TW);
    for (var copy = 0; copy < 2; copy++) {
      for (var i = 0; i < nearMills.length; i++) {
        var m = nearMills[i];
        var mx = m.x + shift + copy * TW;
        if (mx < -20 || mx > LW + 20) continue;
        drawSails(o, mx, HORIZON - LAYER_H + m.hubY, 11, 14, m.phase);
      }
    }

    o.fillStyle = COL_DARK.grass;
    o.fillRect(0, HORIZON, LW, LH - HORIZON);
  }

  // Checkpoint banner across the road
  function drawBanner(seg) {
    var x = seg.sx1;
    var y = seg.sy1;
    var half = seg.sw1;
    var ph = seg.sc1 * 2600 * LH / 2;           // post height in pixels
    if (half < 3) return;
    var clipY = Math.min(y, seg.clip);
    var postW = Math.max(1, Math.round(half * 0.05));
    var top = Math.round(y - ph);
    var barH = Math.max(2, Math.round(ph * 0.16));
    o.fillStyle = '#e8e8e8';
    o.fillRect(Math.round(x - half - postW), top, postW, Math.max(0, clipY - top));
    o.fillRect(Math.round(x + half), top, postW, Math.max(0, clipY - top));
    var blocks = 14;
    var bw = (half * 2 + postW * 2) / blocks;
    for (var b = 0; b < blocks; b++) {
      o.fillStyle = b % 2 === 0 ? '#f4f4f4' : '#d8202a';
      o.fillRect(Math.round(x - half - postW + b * bw), top, Math.ceil(bw), barH);
    }
    o.fillStyle = '#ffd23f';
    var signW = Math.round(half * 0.7);
    o.fillRect(Math.round(x - signW / 2), top + barH, signW, Math.max(1, Math.round(barH * 0.9)));
  }

  function drawRoad() {
    var baseSeg = findSegment(position);
    var basePercent = mod(position, SEG_LEN) / SEG_LEN;
    var playerSeg = findSegment(position + PLAYER_Z);
    var playerPercent = mod(position + PLAYER_Z, SEG_LEN) / SEG_LEN;
    var playerY = lerp(playerSeg.y1, playerSeg.y2, playerPercent);
    var camY = playerY + CAM_H;
    var maxY = LH;
    var x = 0;
    var dx = -(baseSeg.curve * basePercent);
    var n, seg;

    for (n = 0; n < DRAW_DIST; n++) {
      seg = segments[(baseSeg.i + n) % N];
      var looped = seg.i < baseSeg.i;
      var camZ = position - (looped ? trackLength : 0);
      var camX = playerX * ROAD_W - x;
      projectSeg(seg, camX, camY, camZ, 1);
      projectSeg(seg, camX - dx, camY, camZ, 2);
      seg.clip = maxY;
      x += dx;
      dx += seg.curve;

      if (seg.cz <= CAM_DEPTH || seg.sy2 >= seg.sy1 || seg.sy2 >= maxY) continue;
      renderSegment(seg);
      maxY = seg.sy1;
    }

    bucketFx(baseSeg);

    // Sprites and traffic, far to near, clipped by the hills in front
    for (n = DRAW_DIST - 1; n >= 0; n--) {
      seg = segments[(baseSeg.i + n) % N];
      if (seg.cz <= CAM_DEPTH) continue;
      var k;
      for (k = 0; k < seg.cars.length; k++) {
        var car = seg.cars[k];
        var pct = (car.z - seg.z1) / SEG_LEN;
        var scale = lerp(seg.sc1, seg.sc2, pct);
        var spec = CAR_TYPES[car.type];
        var w = scale * spec.w * LW / 2;
        var cxp = lerp(seg.sx1, seg.sx2, pct) + scale * car.offset * ROAD_W * LW / 2;
        var cyp = lerp(seg.sy1, seg.sy2, pct);
        drawSpriteAt(CAR_DRAW[car.type], cxp, cyp, w, w * spec.h / spec.w, seg.clip, car);
      }
      for (k = 0; k < seg.sprites.length; k++) {
        var sp = seg.sprites[k];
        var sspec = SPRITES[sp.type];
        var sw = seg.sc1 * sspec.w * LW / 2;
        var sxp = seg.sx1 + seg.sc1 * sp.offset * ROAD_W * LW / 2;
        if (sp.shake > 0 && !reduceMotion) {      // big scenery wobbles after a hit
          sxp += Math.round(Math.sin(time * 70) * Math.max(1, sw * 0.04) * (sp.shake / 0.55));
        }
        drawSpriteAt(sspec.draw, sxp, seg.sy1, sw, sw * sspec.h / sspec.w, seg.clip, sp);
      }
      for (k = 0; k < seg.fx.length; k++) drawFly(seg, seg.fx[k]);
      if (seg.cp) drawBanner(seg);
    }

    o.drawImage(hazeLayer, 0, HORIZON - 8);
  }

  function drawPlayer() {
    if (boom) { drawWreck(); return; }       // the tractor has blown up
    var px = LW / 2 + playerOffsetPx();
    var py = PLAYER_BY - Math.round(bounce);
    var lean = steerVis;
    drawTractor(o, px, py, PLAYER_S, { body: '#2f9e44', dark: '#1f6b2e', rim: '#e8d36a' }, lean, wheelPhase);
  }

  function drawSmoke() {
    for (var i = 0; i < particles.length; i++) {
      var p = particles[i];
      o.globalAlpha = Math.max(0, Math.min(0.6, p.life / p.max));
      o.fillStyle = '#3a3a3a';
      var sz = Math.round(p.size);
      o.fillRect(Math.round(p.x - sz / 2), Math.round(p.y - sz / 2), sz, sz);
    }
    o.globalAlpha = 1;
  }

  // ---- Drawing: HUD -------------------------------------------------------------

  // Pixel text with a hard drop shadow. Sizes 8 and 16 stay crisp.
  function drawText(text, x, y, size, color, align, shadow) {
    o.font = size + 'px ' + FONT;
    o.textAlign = align || 'center';
    o.textBaseline = 'top';
    var d = size >= 16 ? 2 : 1;
    o.fillStyle = shadow || '#1b2a4a';
    o.fillText(text, x + d, y + d);
    o.fillStyle = color || '#ffffff';
    o.fillText(text, x, y);
  }

  function blink(rate) { return Math.floor(time * rate) % 2 === 0; }

  function panel(x, y, w, h) {
    o.fillStyle = 'rgba(12, 24, 52, 0.82)';
    o.fillRect(x, y, w, h);
    o.fillStyle = '#25f4ee';
    o.fillRect(x, y, w, 1);
    o.fillRect(x, y + h - 1, w, 1);
    o.fillRect(x, y, 1, h);
    o.fillRect(x + w - 1, y, 1, h);
  }

  function formatKm(units) {
    return (units * M_PER_UNIT / 1000).toFixed(2);
  }

  function drawHud() {
    var secs = Math.max(0, Math.ceil(timeLeft));
    var low = timeLeft < 10 && state === 'racing';
    var timeColor = low && blink(2) ? '#ff5a5a' : '#ffe94d';

    drawText('TIME', LW / 2, 3, 8, '#ffffff');
    drawText(String(secs), LW / 2, 13, 16, timeColor);

    drawText('SCORE', 5, 3, 8, '#ffffff', 'left');
    drawText(String(score()), 5, 13, 8, '#ffe94d', 'left');

    drawText('STAGE ' + (cpCount + 1), LW - 5, 3, 8, '#ffffff', 'right');
    drawText(formatKm(distance) + 'KM', LW - 5, 13, 8, '#ffe94d', 'right');

    // Progress to the next checkpoint
    var pi = Math.floor(mod(position + PLAYER_Z, trackLength) / SEG_LEN);
    var into = mod(pi - CP_OFFSET, CP_SPACING);
    var prog = into / CP_SPACING;
    var bx = 70, bwid = 100, by = 33;
    o.fillStyle = 'rgba(12, 24, 52, 0.7)';
    o.fillRect(bx - 1, by - 1, bwid + 2, 5);
    o.fillStyle = '#ffe94d';
    o.fillRect(bx, by, Math.round(bwid * prog), 3);
    o.fillStyle = '#ffffff';
    o.fillRect(bx + bwid, by - 2, 1, 7);

    // Speed
    var kmh = Math.round(speed / MAX_SPEED * KMH_TOP);
    drawText('KM/H', 5, 152, 8, '#ffffff', 'left');
    drawText(String(kmh), 5, 162, 16, '#ffffff', 'left');

    // Messages
    if (messageT > 0 && message) {
      drawText(message, LW / 2, 52, message.length > 6 ? 8 : 16, '#ffe94d', 'center', '#d8202a');
      if (messageSub) drawText(messageSub, LW / 2, 64, 8, '#ffffff');
    }
    for (var i = 0; i < popups.length; i++) {
      var pp = popups[i];
      drawText(pp.text, LW / 2 + 40, 100 - (1.2 - pp.t) * 14, 8, '#7dffb0');
    }
  }

  function drawOverlays() {
    if (state === 'title') {
      panel(26, 46, LW - 52, 92);
      drawText('TRACTOR', LW / 2, 56, 16, '#ffe94d', 'center', '#d8202a');
      drawText('RUN', LW / 2, 76, 16, '#ffe94d', 'center', '#d8202a');
      if (blink(1.5)) drawText('PRESS / TAP TO START', LW / 2, 102, 8, '#ffffff');
      drawText('ARROWS OR WASD TO DRIVE', LW / 2, 116, 8, '#25f4ee');
      if (best > 0) drawText('BEST ' + best, LW / 2, 128, 8, '#ffe94d');
    } else if (state === 'over' && overTime >= 0) {      // after the explosion
      panel(16, 30, LW - 32, 114);
      drawText('TIME UP', LW / 2, 38, 16, '#ff5a5a', 'center');
      drawText('DISTANCE ' + formatKm(distance) + ' KM', LW / 2, 62, 8, '#ffffff');
      drawText('SCORE ' + score(), LW / 2, 76, 8, '#ffe94d');
      drawText('BEST ' + best, LW / 2, 90, 8, '#25f4ee');
      if (newBest && blink(2)) drawText('NEW BEST!', LW / 2, 104, 8, '#7dffb0');
      if (overTime >= RESTART_DELAY && blink(1.5)) {
        drawText('PRESS / TAP TO DRIVE AGAIN', LW / 2, 122, 8, '#ffffff');
      }
    }
  }

  function drawScene() {
    drawBackground();
    drawRoad();
    drawSmoke();
    drawPlayer();
    if (state !== 'title') drawHud();
    // One soft flash as the tractor blows up: at most 30% opacity, 0.2 s, never repeated
    if (boom && !reduceMotion && boom.t < 0.2) {
      o.globalAlpha = 0.3 * (1 - boom.t / 0.2);
      o.fillStyle = '#fff2c0';
      o.fillRect(0, 0, LW, LH);
      o.globalAlpha = 1;
    }
    drawOverlays();
  }

  function draw() {
    drawScene();

    // Scale the low-res scene up onto the visible canvas (with shake)
    var sx = 0;
    var sy = 0;
    if (!reduceMotion) {
      var mag = shakeMag * PIX * 0.5;
      if (shakeT > 0) mag += 5 * (shakeT / 0.4);
      if (mag > 0) {
        sx = Math.round((Math.random() * 2 - 1) * mag / PIX) * PIX;
        sy = Math.round((Math.random() * 2 - 1) * mag / PIX) * PIX;
      }
    }
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.drawImage(off, sx, sy, W, H);
  }

  // ---- Main loop (delta-time, so speed matches on any refresh rate) --------

  var lastTime = null;

  function frame(now) {
    if (lastTime === null) lastTime = now;
    var dt = Math.min((now - lastTime) / 1000, 0.05);  // clamp after tab switch
    lastTime = now;
    if (!paused) update(dt);
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
