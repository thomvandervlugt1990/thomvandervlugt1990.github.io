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
  var SPRITES = {
    tree:     { w: 520,  h: 1500, solid: true,  hit: 0.3,  draw: drawTree },
    poplar:   { w: 300,  h: 1900, solid: true,  hit: 0.4,  draw: drawPoplar },
    windmill: { w: 1700, h: 3300, solid: true,  hit: 0.5,  draw: drawWindmill },
    barn:     { w: 2000, h: 1250, solid: true,  hit: 0.9,  draw: drawBarn },
    hay:      { w: 460,  h: 460,  solid: true,  hit: 0.9,  draw: drawHay },
    cow:      { w: 720,  h: 480,  solid: true,  hit: 0.8,  draw: drawCow },
    tulips:   { w: 2400, h: 260,  solid: false, hit: 0,    draw: drawTulips },
    sign:     { w: 380,  h: 900,  solid: true,  hit: 0.6,  draw: drawSign }
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
  function sfxTimeUp() { tone(440, 220, 0.5, 0.07); }
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
    overTime += dt;
    speed = Math.max(0, speed + BRAKE * 0.5 * dt);
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
    overTime = 0;
    var s = score();
    if (s > best) {
      best = s;
      newBest = true;
      saveBest();
    }
    setMessage('', '', 0);
    stopEngine();
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
          speed = 0;
          position = mod(position - 500, trackLength);
          // Slide to the side of the obstacle that faces the road
          playerX = sp.offset - (sp.offset >= 0 ? 1 : -1) * (PLAYER_HW + hw + 0.05);
          playerX = clamp(playerX, -2.2, 2.2);
          hitCooldown = 0.6;
          if (!reduceMotion) { shakeT = 0.4; }
          sfxCrash();
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
      var dz = wrapDz(car.z - pz);
      var overlapX = Math.abs(playerX - car.offset) < PLAYER_HW + car.hw;

      if (hitCooldown <= 0 && overlapX && dz > -150 && dz < 260 && speed > car.speed) {
        speed = Math.min(speed * 0.3, car.speed * 0.6);
        playerX += (playerX >= car.offset ? 1 : -1) * 0.22;
        playerX = clamp(playerX, -2.2, 2.2);
        hitCooldown = 0.6;
        if (!reduceMotion) shakeT = 0.3;
        sfxBump();
        car.bumped = 1;
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
  function drawTractor(g, cx, by, s, c, lean, phase) {
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

    R(-26, -2, 52, 3, 'rgba(0,0,0,0.28)');                  // shadow
    R(-12 + L * 0.3, -17, 5, 13, TIRE);                      // small front wheels
    R(7 + L * 0.3, -17, 5, 13, TIRE);
    R(-14, -26, 28, 16, c.body);                             // rear body
    R(-14, -12, 28, 3, c.dark);

    // Big rear wheels with tread bars that scroll with speed
    var wheels = [-28, 15];
    for (var w = 0; w < 2; w++) {
      var wx = wheels[w];
      R(wx, -27, 13, 27, TIRE);
      for (var k = 0; k < 6; k++) {
        var ty = mod(k * 5 + Math.floor(phase), 27);
        if (ty > 25) ty = 25;
        R(wx, -27 + ty, 13, 2, TREAD);
      }
      R(w === 0 ? -17 : 15, -20, 2, 13, c.rim);              // rim, inner edge
    }
    R(-29, -30, 16, 4, c.dark);                              // fenders
    R(13, -30, 16, 4, c.dark);
    R(-12, -22, 3, 3, '#ff4a3a');                            // tail lights
    R(9, -22, 3, 3, '#ff4a3a');

    // Cab, leaning a little into the steering direction
    R(-11 + L, -50, 22, 26, c.body);
    R(-9 + L, -47, 18, 16, '#bfe6ff');                       // glass
    R(-9 + L, -47, 18, 2, '#e8f6ff');
    R(-13 + L, -54, 26, 4, c.dark);                          // roof
    R(-4 + L, -42, 8, 7, '#f2c49b');                         // driver: face ...
    R(-5 + L, -45, 10, 3, '#f5d142');                        // ... straw hat
    R(-7 + L, -35, 14, 5, '#2a63b8');                        // ... overalls
    R(8 + L, -66, 3, 14, '#3b3b3b');                         // exhaust pipe
    R(7 + L, -67, 5, 2, '#222222');
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
        drawSpriteAt(sspec.draw, sxp, seg.sy1, sw, sw * sspec.h / sspec.w, seg.clip, sp);
      }
      if (seg.cp) drawBanner(seg);
    }

    o.drawImage(hazeLayer, 0, HORIZON - 8);
  }

  function drawPlayer() {
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
    } else if (state === 'over') {
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
