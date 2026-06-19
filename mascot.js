/**
 * mascot.js — animated sprite mascot for the launcher FAB.
 *
 * Loaded as a content script BEFORE content.js so content.js can call the
 * global `createMascot(...)`.
 *
 * Playback model (per product spec):
 *   • Every scene plays ONCE and freezes on its final frame — nothing loops.
 *   • Default/idle = "secure" (walks, raises shield) → holds on the shield frame.
 *   • After 60s with no activity, it plays "rest" (sit/sleep) once and holds.
 *   • Hovering replays "secure" once and holds (and resets the idle timer).
 *   • Tool events (working / success / error / notify) each play once and hold.
 *
 * Sprite format: per-scene WebP atlas + JSON ({meta:{frameW,frameH,...},
 * frames:{frame_000:{frame:{x,y,w,h},duration}}}). Rendered on a <canvas>
 * via requestAnimationFrame; honours prefers-reduced-motion and pauses when
 * the tab is hidden.
 */

/* global chrome */
function createMascot({ mount, height = 96, onClick, assetDir = "assets/mascot", idleScene = "idle", idleLoop = false, hoverScene = null } = {}) {
  // semantic scene → asset basename under assets/mascot/
  const SCENES = {
    idle:     "secure",     // walks, raises shield → hold on shield (used as hover for ControlMap)
    stand:    "stand",      // calm breathing idle stance (ControlMap default idle)
    rest:     "sleep",      // 60s-idle → sleeping astronaut (Zzz) → hold
    sit:      "sit",        // (kept) earlier sit/rest pose
    greet:    "greet",      // (available) talking/greeting gesture
    working:  "run",        // checks running / attaching (runs with a bin) — loops
    thinking: "thinking",   // alt in-progress (… dots)
    success:  "celebrate",  // jump + folder + sparkles
    notify:   "point",      // attention / has results (points at clipboard)
    error:    "thinking",   // concerned pause
  };

  const DROWSE_MS = 30000;  // 30s idle → thinking (…)
  const SLEEP_MS  = 60000;  // 60s idle → sleep (Zzz)
  const url = (f) => chrome.runtime.getURL(`${assetDir}/${f}`);
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const cache = {};         // base -> { img, frames[], frameW, frameH }
  let current = null;       // { def, i, lastTs, loop, onEnd }
  let sequence = null;      // { scenes:[key], i, loop } — alternating multi-scene loop
  let raf = null, paused = false, disabled = false;
  let t30 = null, t60 = null;   // idle drowse / sleep timers
  let busy = false;             // a real task animation is in progress
  let idleStage = "active";     // "active" | "drowsy" | "asleep"

  const canvas = document.createElement("canvas");
  canvas.className = "cm-mascot";
  const ctx = canvas.getContext("2d");
  canvas.style.cssText =
    `height:${height}px;width:auto;display:block;cursor:pointer;` +
    `filter:drop-shadow(0 6px 14px rgba(40,30,90,.35));transition:transform .15s ease;`;
  canvas.addEventListener("mouseenter", () => {
    canvas.style.transform = "scale(1.06)";
    if (busy) return;                 // don't interrupt a running task
    if (hoverScene) { clearTimers(); idleStage = "active"; play(hoverScene); }  // show shield while hovered
    else enterIdle();                 // no distinct hover scene → just replay idle + reset timers
  });
  canvas.addEventListener("mouseleave", () => {
    canvas.style.transform = "scale(1)";
    if (busy) return;
    if (hoverScene) enterIdle();      // un-hover → back to the idle stance + restart drowse
  });
  if (onClick) canvas.addEventListener("click", onClick);
  mount.appendChild(canvas);

  async function load(sceneKey) {
    const base = SCENES[sceneKey] || SCENES.idle;
    if (cache[base]) return cache[base];
    const meta = await fetch(url(base + ".json")).then((r) => r.json());
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im); im.onerror = rej;
      im.src = url(meta.meta.image);
    });
    const frames = Object.keys(meta.frames).sort().map((k) => meta.frames[k]);
    const def = { name: base, img, frames, frameW: meta.meta.frameW, frameH: meta.meta.frameH };
    cache[base] = def;
    return def;
  }

  function sizeCanvas(def) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = def.frameW * dpr;
    canvas.height = def.frameH * dpr;
    canvas.style.width = (height * def.frameW / def.frameH) + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function drawFrame(def, i) {
    const f = def.frames[i].frame;
    ctx.clearRect(0, 0, def.frameW, def.frameH);
    ctx.drawImage(def.img, f.x, f.y, f.w, f.h, 0, 0, def.frameW, def.frameH);
  }

  // Either loop forever (in-progress states) or play once and freeze on the
  // final frame, firing onEnd.
  function tick(ts) {
    raf = null;
    if (!current || paused || disabled) return;
    const { def } = current;
    if (current.lastTs == null) current.lastTs = ts;
    if (ts - current.lastTs >= (def.frames[current.i].duration || 60)) {
      current.lastTs = ts;
      if (current.i >= def.frames.length - 1) {
        if (current.loop) {
          current.i = 0;
          drawFrame(def, 0);
        } else {
          drawFrame(def, def.frames.length - 1);   // hold last frame
          const cb = current.onEnd; current = null;
          if (cb) cb();
          return;
        }
      } else {
        current.i++;
        drawFrame(def, current.i);
      }
    }
    raf = requestAnimationFrame(tick);
  }

  async function play(sceneKey, { loop = false, onEnd = null } = {}) {
    try {
      const def = await load(sceneKey);
      sizeCanvas(def);
      drawFrame(def, 0);
      if (disabled || reduceMotion) {            // static: hold first frame, fire onEnd shortly
        current = null;
        if (onEnd) setTimeout(onEnd, 300);
        return;
      }
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      current = { def, i: 0, lastTs: null, loop, onEnd };
      raf = requestAnimationFrame(tick);
    } catch { /* asset missing → leave canvas as-is */ }
  }

  // Play several scenes in a row, each once; when the list ends, loop (or stop).
  // Used for the "working" state which alternates present ↔ point while busy.
  function playSequence(sceneKeys, { loop = true } = {}) {
    sequence = { scenes: sceneKeys.slice(), i: 0, loop };
    runSeqStep();
  }
  function runSeqStep() {
    if (!sequence) return;
    const scene = sequence.scenes[sequence.i];
    play(scene, { onEnd: () => {
      if (!sequence) return;                 // interrupted by another setState
      sequence.i++;
      if (sequence.i >= sequence.scenes.length) {
        if (sequence.loop) sequence.i = 0;
        else { sequence = null; return; }
      }
      runSeqStep();
    }});
  }

  function clearTimers() {
    if (t30) { clearTimeout(t30); t30 = null; }
    if (t60) { clearTimeout(t60); t60 = null; }
  }

  // While idle and untouched: 30s → thinking (…), 60s → sleep (Zzz). Both loop.
  function armDrowse() {
    clearTimers();
    idleStage = "active";
    t30 = setTimeout(() => {
      idleStage = "drowsy";
      play("thinking");                 // plays once, holds on last frame
    }, DROWSE_MS);
    t60 = setTimeout(() => {
      idleStage = "asleep";
      play("rest", { loop: true });
    }, SLEEP_MS);
  }

  // Default idle stance, then the drowse → sleep countdown.
  function enterIdle() {
    busy = false;
    idleStage = "active";
    clearTimers();
    sequence = null;
    play(idleScene, { loop: idleLoop });   // breathing idle loops; static idle holds
    armDrowse();                           // 30s → thinking, 60s → sleep
  }

  // Any click/activity keeps him awake: wake if drowsy/asleep, else just reset timers.
  function bump() {
    if (busy) return;                       // a real task is animating — leave it
    if (idleStage === "drowsy" || idleStage === "asleep") enterIdle();
    else armDrowse();
  }

  // tool state → scene.
  //  • working / thinking loop until the task finishes.
  //  • success / error / notify play once, then return to the idle shield stance.
  //  • idle = default shield stance + drowse→sleep countdown.
  function setState(state) {
    clearTimers();
    sequence = null;
    if (state === "idle") { enterIdle(); return; }
    if (state === "working") { busy = true; play("working", { loop: true }); return; }
    if (state === "thinking") { busy = true; play("thinking", { loop: true }); return; }
    if (state === "success" || state === "error" || state === "notify") {
      busy = true;
      play(state, { onEnd: enterIdle });    // celebrate/etc → back to shield, then drowse
      return;
    }
    enterIdle();
  }

  document.addEventListener("visibilitychange", () => {
    paused = document.hidden;
    if (!paused && current && !raf) { current.lastTs = null; raf = requestAnimationFrame(tick); }
  });

  return {
    canvas,
    setState,
    play,
    bump,
    setDisabled(v) {
      disabled = v;
      clearTimers();
      sequence = null;
      busy = false;
      idleStage = "active";
      if (raf) { cancelAnimationFrame(raf); raf = null; }
      current = null;
      play("idle");          // freeze on shield first frame
    },
  };
}
