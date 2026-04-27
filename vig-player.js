/**
 * <vig-player> — a clip-making video player web component.
 *
 * Designed for the vig project, but standalone: no framework, no build step,
 * no dependencies. Drop the file in, register the element, use it like:
 *
 *   <vig-player src="movie.mp4" poster="poster.jpg" frame-rate="30">
 *     <script type="application/json" slot="shots">
 *       [{"start": 12.5, "end": 18.2}, {"start": 60, "end": 64.5}]
 *     </script>
 *   </vig-player>
 *
 * Listen for shot edits and persist them however you like:
 *
 *   document.querySelector('vig-player')
 *     .addEventListener('shots-change', (e) => {
 *       fetch('/_api/shots?path=' + encodeURIComponent(rel), {
 *         method: 'POST',
 *         headers: {'Content-Type': 'application/json'},
 *         body: JSON.stringify(e.detail.shots),
 *       });
 *     });
 *
 * Keyboard (when player is focused or fullscreen):
 *   space / k       play/pause
 *   j / l           jump -/+ 10s
 *   ← / →           jump -/+ 5s
 *   , / .           step 1 frame back / forward
 *   shift+← / →     jump -/+ 1s
 *   0–9             jump to 0% .. 90%
 *   m               mute toggle
 *   f               fullscreen toggle
 *   p               picture-in-picture toggle
 *   < / >           playback speed down / up
 *   i               mark in (at current time)
 *   o               mark out (at current time)
 *   shift+i / o     seek to in / out
 *   enter           commit pending in/out as a new shot
 *   esc             clear pending marks
 *   ?               show / hide keyboard help
 */

const CSS = `
  :host {
    --vp-bg: #0a0a0a;
    --vp-fg: #fff;
    --vp-muted: #9ca3af;
    --vp-accent: #f43f5e;
    --vp-accent-soft: rgba(244, 63, 94, 0.35);
    --vp-shot: rgba(244, 63, 94, 0.55);                  /* active clip — red */
    --vp-shot-edge: rgb(244, 63, 94);
    --vp-marker: rgba(180, 180, 180, 0.95);              /* inactive marker — grey */
    --vp-mark-in: rgb(56, 189, 248);
    --vp-mark-out: rgb(251, 191, 36);
    --vp-buffer: rgba(255, 255, 255, 0.18);
    --vp-track: rgba(255, 255, 255, 0.12);
    --vp-radius: 6px;
    --vp-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    --vp-control-h: 44px;

    display: block;
    position: relative;
    background: var(--vp-bg);
    color: var(--vp-fg);
    font: 13px/1.3 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    user-select: none;
    -webkit-user-select: none;
    contain: layout paint;
  }

  :host([hidden]) { display: none; }

  *, *::before, *::after { box-sizing: border-box; }
  button {
    background: transparent;
    border: 0;
    color: inherit;
    font: inherit;
    cursor: pointer;
    padding: 0;
    line-height: 1;
  }
  button:disabled { opacity: 0.4; cursor: default; }
  button:focus-visible { outline: 2px solid var(--vp-accent); outline-offset: 2px; }

  .vp-root {
    position: relative;
    display: grid;
    grid-template-rows: 1fr auto;
    width: 100%;
    height: 100%;
    min-height: 200px;
    outline: none;
  }

  /* ─── Stage ─── */
  .vp-stage {
    position: relative;
    background: #000;
    overflow: hidden;
    min-height: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .vp-video {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 100%;
    object-fit: contain;
    background: #000;
  }

  .vp-bigplay {
    position: absolute;
    inset: 0;
    margin: auto;
    width: 84px;
    height: 84px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;             /* zone 3 owns the click */
    transition: opacity 160ms, transform 160ms;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .vp-bigplay svg { width: 38px; height: 38px; fill: currentColor; transform: translateX(2px); }
  .vp-root.is-playing .vp-bigplay { opacity: 0; transform: scale(0.92); pointer-events: none; }
  .vp-root.is-paused .vp-bigplay { opacity: 1; }

  /* ─── Tap zones over the video frame ─── */
  .vp-zones {
    position: absolute;
    inset: 0;
    display: grid;
    grid-template-columns: 1fr 3fr 1fr;
    z-index: 2;
  }
  .vp-zone-center { touch-action: pan-y; }   /* horizontal pointer = our swipe */
  .vp-zone {
    background: transparent;
    border: 0;
    padding: 0;
    margin: 0;
    color: inherit;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    transition: background 160ms;
  }
  .vp-zone:hover  { background: rgba(255, 255, 255, 0.04); }
  .vp-zone:active { background: rgba(255, 255, 255, 0.10); }
  .vp-zone:focus-visible {
    outline: 2px solid var(--vp-accent);
    outline-offset: -4px;
    background: rgba(255, 255, 255, 0.04);
  }

  .vp-zone-flash {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 96px;
    height: 96px;
    margin: -48px 0 0 -48px;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    pointer-events: none;
    opacity: 0;
    transform: scale(0.7);
    transition: opacity 200ms, transform 200ms;
    z-index: 3;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .vp-zone-flash.is-visible { opacity: 1; transform: scale(1); }
  .vp-zone-flash svg { width: 44px; height: 44px; fill: white; stroke: white; }

  .vp-toast {
    position: absolute;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.78);
    padding: 6px 12px;
    border-radius: 99px;
    font-size: 12px;
    letter-spacing: 0.02em;
    pointer-events: none;
    opacity: 0;
    transition: opacity 200ms;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .vp-toast.is-visible { opacity: 1; }

  /* ─── Controls bar ─── */
  .vp-controls {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 10px 8px;
    background: linear-gradient(to top, #000, #0a0a0a);
    border-top: 1px solid rgba(255,255,255,0.06);
  }
  .vp-bar {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .vp-bar-spacer { flex: 1; }
  .vp-icon-btn {
    width: var(--vp-control-h);
    height: var(--vp-control-h);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--vp-radius);
    color: var(--vp-fg);
    transition: background 120ms;
  }
  .vp-icon-btn:hover { background: rgba(255,255,255,0.08); }
  .vp-icon-btn svg { width: 18px; height: 18px; fill: currentColor; }

  .vp-time {
    font-variant-numeric: tabular-nums;
    color: var(--vp-muted);
    font-size: 12px;
    letter-spacing: 0.02em;
    min-width: 84px;
    text-align: center;
    user-select: text;
  }
  .vp-time .now { color: var(--vp-fg); }

  .vp-speed {
    min-width: 44px;
    height: var(--vp-control-h);
    border-radius: var(--vp-radius);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
    padding: 0 8px;
  }
  .vp-speed:hover { background: rgba(255,255,255,0.08); }

  /* YouTube-style: speaker icon stays visible, slider expands on hover. */
  .vp-volume-wrap {
    display: inline-flex;
    align-items: center;
    border-radius: var(--vp-radius);
  }
  .vp-volume {
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: var(--vp-track);
    border-radius: 99px;
    outline: none;
    width: 0;
    opacity: 0;
    margin: 0;
    pointer-events: none;
    /* delayed close so a quick mouse drift doesn't snap the slider shut */
    transition: width 200ms 250ms, opacity 200ms 250ms, margin 200ms 250ms;
  }
  .vp-volume-wrap:hover .vp-volume,
  .vp-volume-wrap:focus-within .vp-volume {
    width: 80px;
    opacity: 1;
    margin: 0 4px 0 6px;
    pointer-events: auto;
    transition: width 160ms, opacity 160ms, margin 160ms;
  }
  .vp-volume::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--vp-fg);
    cursor: pointer;
  }
  .vp-volume::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--vp-fg);
    border: 0;
    cursor: pointer;
  }

  /* ─── Timeline ─── */
  .vp-timeline {
    position: relative;
    height: var(--vp-control-h);
    display: flex;
    align-items: center;
    cursor: pointer;
    touch-action: none;
  }
  .vp-track {
    position: relative;
    height: 6px;
    width: 100%;
    background: var(--vp-track);
    border-radius: 99px;
    overflow: visible;
    transition: height 120ms;
  }
  .vp-timeline:hover .vp-track,
  .vp-timeline.is-scrubbing .vp-track { height: 10px; }
  .vp-buffer,
  .vp-progress {
    position: absolute;
    inset: 0 auto 0 0;
    height: 100%;
    border-radius: inherit;
    pointer-events: none;
  }
  .vp-buffer { background: var(--vp-buffer); }
  .vp-progress { background: var(--vp-accent); }
  .vp-thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--vp-fg);
    transform: translate(-50%, -50%);
    pointer-events: none;
    box-shadow: 0 0 0 4px var(--vp-accent-soft);
    opacity: 0;
    transition: opacity 120ms;
  }
  .vp-timeline:hover .vp-thumb,
  .vp-timeline.is-scrubbing .vp-thumb { opacity: 1; }

  .vp-shot-overlays { position: absolute; inset: 0; pointer-events: none; }

  /* ─── Clip range above/below the track with two fat handles ─── */
  .vp-shot {
    position: absolute;
    top: -3px;
    bottom: -3px;
    border-radius: 6px;
    pointer-events: auto;
    cursor: grab;
    border-width: 2px;
    border-style: solid;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.4);
  }
  .vp-shot:active { cursor: grabbing; }
  .vp-shot.is-active {
    background: var(--vp-shot);
    border-color: var(--vp-shot-edge);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.4), 0 0 12px rgba(244, 63, 94, 0.3);
  }
  .vp-shot.is-inactive {
    background: rgba(180, 180, 180, 0.25);
    border-color: rgba(180, 180, 180, 0.7);
  }

  .vp-shot-handle {
    position: absolute;
    top: -10px;
    bottom: -10px;
    width: 14px;
    border-radius: 4px;
    cursor: ew-resize;
    pointer-events: auto;
    box-shadow: 0 1px 4px rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
  }
  .vp-shot-handle::before {
    content: "";
    width: 2px;
    height: 12px;
    border-radius: 1px;
  }
  .vp-shot-handle.left  { left:  -7px; border-radius: 4px 0 0 4px; }
  .vp-shot-handle.right { right: -7px; border-radius: 0 4px 4px 0; }
  .vp-shot.is-active   .vp-shot-handle         { background: var(--vp-shot-edge); }
  .vp-shot.is-active   .vp-shot-handle::before { background: rgba(255,255,255,0.7); }
  .vp-shot.is-inactive .vp-shot-handle         { background: var(--vp-marker); }
  .vp-shot.is-inactive .vp-shot-handle::before { background: rgba(0,0,0,0.45); }

  /* ─── Hover-X delete on the left handle ─── */
  .vp-handle-del {
    position: absolute;
    top: -8px;
    right: -8px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: #1f1f1f;
    color: white;
    font: 700 12px/1 inherit;
    display: none;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    border: 1px solid rgba(255,255,255,0.25);
    box-shadow: 0 2px 4px rgba(0,0,0,0.5);
    z-index: 2;
  }
  .vp-shot-handle:hover .vp-handle-del,
  .vp-handle-del:hover { display: inline-flex; }
  .vp-handle-del:hover { background: #ef4444; border-color: #ef4444; }

  .vp-marks { position: absolute; inset: 0; pointer-events: none; }
  .vp-mark {
    position: absolute;
    top: -10px;
    bottom: -10px;
    width: 2px;
    border-radius: 2px;
    transform: translateX(-1px);
    box-shadow: 0 0 6px currentColor;
  }
  .vp-mark.in  { background: var(--vp-mark-in);  color: var(--vp-mark-in); }
  .vp-mark.out { background: var(--vp-mark-out); color: var(--vp-mark-out); }
  .vp-mark.pending-range {
    top: 0; bottom: 0;
    background: linear-gradient(90deg, var(--vp-mark-in), var(--vp-mark-out));
    opacity: 0.45;
    border-radius: 99px;
    box-shadow: none;
  }

  .vp-hover-tip {
    position: absolute;
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.85);
    padding: 3px 8px;
    border-radius: 4px;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    pointer-events: none;
    white-space: nowrap;
    opacity: 0;
    transition: opacity 120ms;
  }
  .vp-timeline:hover .vp-hover-tip,
  .vp-timeline.is-scrubbing .vp-hover-tip { opacity: 1; }

  /* ─── Help ─── */
  .vp-help {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.86);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 5;
    padding: 24px;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
  }
  .vp-help.is-visible { display: flex; }
  .vp-help-card {
    background: #111;
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 10px;
    padding: 18px 22px;
    max-width: 540px;
    width: 100%;
    box-shadow: var(--vp-shadow);
    pointer-events: auto;
  }
  .vp-help-card h3 {
    margin: 0 0 12px;
    font-size: 14px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--vp-muted);
  }
  .vp-help-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 14px;
    row-gap: 6px;
    font-size: 13px;
  }
  .vp-help-grid kbd {
    font: 12px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
    background: rgba(255,255,255,0.08);
    padding: 1px 7px;
    border-radius: 4px;
    border: 1px solid rgba(255,255,255,0.12);
    white-space: nowrap;
  }

  /* ─── Mobile ─── */
  @media (max-width: 540px) {
    /* Mobile: rely on hardware volume keys; just keep the mute toggle. */
    .vp-volume-wrap:hover .vp-volume,
    .vp-volume-wrap:focus-within .vp-volume,
    .vp-volume { width: 0; opacity: 0; margin: 0; pointer-events: none; }
    .vp-time { min-width: 64px; font-size: 11px; }
    .vp-shot-handle { width: 14px; }                       /* fatter for fingers */
    .vp-icon-btn { width: 40px; height: 40px; }
  }
`;

const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  volumeOn: '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4z"/></svg>',
  volumeOff: '<svg viewBox="0 0 24 24"><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4v2.2l2.5 2.5V12zM3 4.27 5.5 6.77 5.5 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06A8.94 8.94 0 0 0 17.5 18.5l2.23 2.23 1.27-1.27L4.27 3 3 4.27zM12 4 9.91 6.09 12 8.18V4z"/></svg>',
  fullscreen: '<svg viewBox="0 0 24 24"><path d="M5 5h5V3H3v7h2V5zm14 0v5h2V3h-7v2h5zM5 14H3v7h7v-2H5v-5zm14 5h-5v2h7v-7h-2v5z"/></svg>',
  exitFullscreen: '<svg viewBox="0 0 24 24"><path d="M5 16h3v3h2v-5H5v2zM8 8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>',
  pip: '<svg viewBox="0 0 24 24"><path d="M21 3H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 16H3V4.97h18V19zm-3-7h-7v5h7v-5z"/></svg>',
  markIn: '<svg viewBox="0 0 24 24"><path d="M5 4v16h2V4H5zm14 0L9 12l10 8V4z"/></svg>',
  markOut: '<svg viewBox="0 0 24 24"><path d="M5 4l10 8L5 20V4zm14 0v16h-2V4h2z"/></svg>',
  add: '<svg viewBox="0 0 24 24"><path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z"/></svg>',
  clip: '<svg viewBox="0 0 24 24"><path d="M4 6h2v12H4zM7 6h11l-2 3 2 3-2 3 2 3H7z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>',
  close: '<svg viewBox="0 0 24 24"><path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>',
  skipBack:    '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zM20 6 9 12l11 6z"/></svg>',
  skipForward: '<svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM4 6v12l11-6z"/></svg>',
  speedDown: '<svg viewBox="0 0 24 24"><path d="M11 18V6L2.5 12 11 18zm10 0V6l-8.5 6 8.5 6z"/></svg>',
  speedUp:   '<svg viewBox="0 0 24 24"><path d="M13 6v12l8.5-6L13 6zM3 18l8.5-6L3 6v12z"/></svg>',
  help: '<svg viewBox="0 0 24 24"><path d="M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z"/></svg>',
};

function fmtTime(seconds, opts = {}) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  const base = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return opts.ms ? `${base}.${String(ms).padStart(3, "0")}` : base;
}

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

class VigPlayer extends HTMLElement {
  static get observedAttributes() {
    return ["src", "poster", "frame-rate", "autoplay", "muted", "start-at",
            "center-action", "back-href", "prev-href", "next-href"];
  }

  constructor() {
    super();
    this._shots = [];          // each: { start, end, active: bool, label? }
    this._pendingIn = null;
    this._pendingOut = null;
    this._scrubbing = null;       // { type: 'seek' | 'shot-move' | 'shot-resize-l' | 'shot-resize-r', shotIndex?, anchor? }
    this._toastTimer = null;
    this._stopAt = null;
    this._lastEmitted = null;
    this._wired = false;
    this._slotRead = false;
    this._startAt = null;
    this._startAtApplied = false;
    this.attachShadow({ mode: "open" });
    // Render eagerly so users can poke at .shots / .currentTime before insertion.
    this._render();
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  connectedCallback() {
    if (!this._wired) { this._wireEvents(); this._wired = true; }
    if (!this._slotRead) { this._readShotsFromSlot(); this._slotRead = true; }
    this._sync();
  }

  attributeChangedCallback(name, _old, val) {
    if (!this.$video) return; // pre-construction calls (defensive)
    if (name === "src") {
      this.$video.src = val || "";
      this._startAtApplied = false; // re-arm seek for the new source
    }
    else if (name === "poster") this.$video.poster = val || "";
    else if (name === "frame-rate") this._frameRate = parseFloat(val) || 30;
    else if (name === "autoplay") this.$video.autoplay = val !== null;
    else if (name === "muted")    this.$video.muted    = val !== null;
    else if (name === "start-at") {
      const t = parseFloat(val);
      this._startAt = isFinite(t) && t > 0 ? t : null;
      this._startAtApplied = false;
      this._maybeApplyStartAt();
    }
  }

  // Seek to start-at once we know the duration (or as soon as we have any
  // metadata). Idempotent — the flag prevents re-applying on later src/attr
  // changes that were already handled.
  _maybeApplyStartAt() {
    if (this._startAtApplied || this._startAt === null || !this.$video) return;
    const v = this.$video;
    if (v.readyState >= 1) {
      const target = isFinite(v.duration) && v.duration > 0
        ? Math.min(this._startAt, v.duration - 0.1)
        : this._startAt;
      v.currentTime = target;
      this._startAtApplied = true;
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  // Each shot is { start, end, active, label? }. `active === false` clips are
  // grey on the timeline; once edited they flip to red.
  get shots() { return this._shots.map((s) => ({ ...s })); }
  set shots(arr) { this.items = arr; }
  // For backwards-compat with code that filtered on shape: `markers` returns
  // the inactive ones, `activeShots` the active ones.
  get markers()     { return this._shots.filter((s) => !s.active).map((s) => ({ ...s })); }
  get activeShots() { return this._shots.filter((s) =>  s.active).map((s) => ({ ...s })); }
  get items()       { return this._shots.map((s) => ({ ...s })); }

  set items(arr) {
    const list = Array.isArray(arr) ? arr : [];
    this._shots = list
      .filter((s) => isFinite(s.start) && isFinite(s.end) && s.end > s.start)
      .map((s) => ({
        start: +s.start,
        end:   +s.end,
        // Default active=true for legacy data (existing .shots.json entries
        // without an `active` field are assumed to be finished clips).
        active: s.active === undefined ? true : !!s.active,
        ...(s.label ? { label: String(s.label) } : {}),
      }))
      .sort((a, b) => a.start - b.start);
    this._renderShots();
    this._renderShotChips();
  }

  get currentTime() { return this.$video?.currentTime || 0; }
  set currentTime(t) { if (this.$video) this.$video.currentTime = t; }

  play() { return this.$video?.play(); }
  pause() { return this.$video?.pause(); }

  setStatus(_state /* 'idle' | 'saving' | 'saved' | 'error' */, text) {
    // The dedicated status element was removed; surface text via the toast so
    // host code calling setStatus() still gives the user feedback.
    if (text) this._toast(text);
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  _render() {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    this.shadowRoot.adoptedStyleSheets = [sheet];

    const root = document.createElement("div");
    root.className = "vp-root is-paused";
    root.tabIndex = 0;
    root.innerHTML = `
      <div class="vp-stage">
        <video class="vp-video" playsinline preload="metadata"></video>
        <div class="vp-zones" role="group" aria-label="Tap zones">
          <button class="vp-zone vp-zone-prev"   type="button" data-action="prev-clip" aria-label="Previous clip"></button>
          <button class="vp-zone vp-zone-center" type="button" data-action="center"    aria-label="Pause / play (swipe ← slower, → faster)"></button>
          <button class="vp-zone vp-zone-next"   type="button" data-action="next-clip" aria-label="Next clip"></button>
        </div>
        <div class="vp-bigplay" aria-hidden="true">${ICON.play}</div>
        <div class="vp-zone-flash" aria-hidden="true"></div>
        <div class="vp-toast" role="status"></div>
        <div class="vp-help" role="dialog" aria-modal="true">
          <div class="vp-help-card">
            <h3>Tap zones over the video</h3>
            <div class="vp-help-grid">
              <kbd>Left</kbd><span>Previous clip</span>
              <kbd>Centre</kbd><span>Pause / play (or Back, depending on context)</span>
              <kbd>Swipe ← →</kbd><span>Slower / faster (within centre)</span>
              <kbd>Right</kbd><span>Next clip</span>
            </div>
            <h3 style="margin-top: 16px;">Clip flow</h3>
            <div class="vp-help-grid">
              <kbd>Seek</kbd><span>Tap or drag the timeline → grey inactive clip on that point</span>
              <kbd>Drag handle</kbd><span>Resize the start / end → clip turns red (active)</span>
              <kbd>Drag body</kbd><span>Move a clip → also activates it</span>
              <kbd>Tap clip</kbd><span>Play just that clip</span>
              <kbd>Hover ×</kbd><span>Delete a clip</span>
            </div>
            <h3 style="margin-top: 16px;">Keyboard shortcuts</h3>
            <div class="vp-help-grid">
              <kbd>Space</kbd><span>Play / pause</span>
              <kbd>J / L</kbd><span>Seek ∓ 10s</span>
              <kbd>← / →</kbd><span>Seek ∓ 5s</span>
              <kbd>Shift+← / →</kbd><span>Seek ∓ 1s</span>
              <kbd>, / .</kbd><span>Step 1 frame back / forward</span>
              <kbd>0 – 9</kbd><span>Jump to 0 % – 90 %</span>
              <kbd>M</kbd><span>Mute</span>
              <kbd>F</kbd><span>Fullscreen</span>
              <kbd>P</kbd><span>Picture-in-picture</span>
              <kbd>&lt; / &gt;</kbd><span>Speed −/+</span>
              <kbd>?</kbd><span>This help</span>
            </div>
          </div>
        </div>
      </div>

      <div class="vp-controls">
        <div class="vp-timeline">
          <div class="vp-track">
            <div class="vp-buffer"></div>
            <div class="vp-progress"></div>
            <div class="vp-shot-overlays"></div>
            <div class="vp-marks">
              <div class="vp-mark pending-range" hidden></div>
              <div class="vp-mark in" hidden></div>
              <div class="vp-mark out" hidden></div>
            </div>
            <div class="vp-thumb"></div>
          </div>
          <div class="vp-hover-tip">0:00</div>
        </div>

        <div class="vp-bar">
          <button class="vp-icon-btn vp-play-btn" type="button" aria-label="Play">${ICON.play}</button>
          <div class="vp-time"><span class="now">0:00</span> <span class="vp-muted">/</span> <span class="dur">0:00</span></div>

          <div class="vp-bar-spacer"></div>

          <button class="vp-speed" type="button" aria-label="Playback speed">1×</button>
          <div class="vp-volume-wrap">
            <button class="vp-icon-btn vp-mute-btn" type="button" aria-label="Mute">${ICON.volumeOn}</button>
            <input class="vp-volume" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume">
          </div>
          <button class="vp-icon-btn vp-pip-btn" type="button" aria-label="Picture-in-picture">${ICON.pip}</button>
          <button class="vp-icon-btn vp-fs-btn" type="button" aria-label="Fullscreen">${ICON.fullscreen}</button>
          <button class="vp-icon-btn vp-help-btn" type="button" aria-label="Keyboard shortcuts">${ICON.help}</button>
        </div>
      </div>

    `;
    this.shadowRoot.appendChild(root);

    // Refs.
    this.$root      = root;
    this.$stage     = root.querySelector(".vp-stage");
    this.$video     = root.querySelector(".vp-video");
    this.$bigplay   = root.querySelector(".vp-bigplay");
    this.$zones     = root.querySelector(".vp-zones");
    this.$zoneFlash = root.querySelector(".vp-zone-flash");
    this.$toast     = root.querySelector(".vp-toast");
    this.$help      = root.querySelector(".vp-help");
    this.$playBtn   = root.querySelector(".vp-play-btn");
    this.$now       = root.querySelector(".vp-time .now");
    this.$dur       = root.querySelector(".vp-time .dur");
    this.$timeline  = root.querySelector(".vp-timeline");
    this.$track     = root.querySelector(".vp-track");
    this.$buffer    = root.querySelector(".vp-buffer");
    this.$progress  = root.querySelector(".vp-progress");
    this.$thumb     = root.querySelector(".vp-thumb");
    this.$shotsBox  = root.querySelector(".vp-shot-overlays");
    this.$markIn    = root.querySelector(".vp-mark.in");
    this.$markOut   = root.querySelector(".vp-mark.out");
    this.$markRng   = root.querySelector(".vp-mark.pending-range");
    this.$hoverTip  = root.querySelector(".vp-hover-tip");
    this.$speed     = root.querySelector(".vp-speed");
    this.$muteBtn   = root.querySelector(".vp-mute-btn");
    this.$volume    = root.querySelector(".vp-volume");
    this.$pipBtn    = root.querySelector(".vp-pip-btn");
    this.$fsBtn     = root.querySelector(".vp-fs-btn");
    this.$helpBtn   = root.querySelector(".vp-help-btn");

    if (this.hasAttribute("src"))    this.$video.src    = this.getAttribute("src");
    if (this.hasAttribute("poster")) this.$video.poster = this.getAttribute("poster");
    this._frameRate = parseFloat(this.getAttribute("frame-rate")) || 30;
    if (this.hasAttribute("autoplay")) this.$video.autoplay = true;
    if (this.hasAttribute("muted"))    this.$video.muted    = true;
    if (this.hasAttribute("start-at")) {
      const t = parseFloat(this.getAttribute("start-at"));
      this._startAt = isFinite(t) && t > 0 ? t : null;
    }

    // Hide PiP button if unsupported.
    if (!document.pictureInPictureEnabled) this.$pipBtn.hidden = true;
  }

  _readShotsFromSlot() {
    // Initial state can be passed as <script type="application/json" slot="shots">[...]</script>.
    // Items with `end` become active clips, items without become markers.
    const slotted = this.querySelector('script[type="application/json"][slot="shots"], script.shots-initial');
    if (slotted && slotted.textContent.trim()) {
      try { this.items = JSON.parse(slotted.textContent); }
      catch (err) { console.warn("[vig-player] could not parse initial items", err); }
    } else {
      this._renderShots();
      this._renderShotChips();
    }
  }

  // ─── Events ────────────────────────────────────────────────────────────────

  _wireEvents() {
    const v = this.$video;

    // Video element events.
    v.addEventListener("play",  () => { this.$root.classList.add("is-playing"); this.$root.classList.remove("is-paused"); this.$playBtn.innerHTML = ICON.pause; });
    v.addEventListener("pause", () => { this.$root.classList.remove("is-playing"); this.$root.classList.add("is-paused"); this.$playBtn.innerHTML = ICON.play; });
    v.addEventListener("loadedmetadata", () => { this._maybeApplyStartAt(); this._sync(); });
    v.addEventListener("durationchange", () => this._sync());
    v.addEventListener("loadeddata", () => this._maybeApplyStartAt());
    v.addEventListener("progress", () => this._renderBuffer());
    v.addEventListener("volumechange", () => this._renderVolume());
    v.addEventListener("ratechange", () => this._renderSpeed());
    v.addEventListener("timeupdate", () => this._onTimeUpdate());
    if ("requestVideoFrameCallback" in v) {
      // Smoother progress rendering in active playback than timeupdate's ~4Hz.
      const tick = () => {
        if (!this.isConnected) return;
        this._renderProgress();
        v.requestVideoFrameCallback(tick);
      };
      v.requestVideoFrameCallback(tick);
    }

    // Tap zones over the video frame. The edges (prev / next) are simple click
    // targets; the centre zone uses pointer events to distinguish a tap (= the
    // configured center action) from a horizontal swipe (= speed −/+).
    this.$zones.addEventListener("click", (e) => {
      const z = e.target.closest(".vp-zone");
      if (!z) return;
      // Mouse / touch on the centre is handled by the pointer logic below.
      // e.detail === 0 means the click came from the keyboard (Enter / Space)
      // — let those fall through so the centre stays keyboard-accessible.
      if (z.classList.contains("vp-zone-center") && e.detail !== 0) return;
      this._toggleHelp(false);
      this._handleZone(z.dataset.action);
    });

    const center = this.$zones.querySelector(".vp-zone-center");
    const SWIPE_THRESHOLD = 40;   // px before a horizontal drag counts as a swipe
    let downX = null;
    let downY = null;
    let downTime = 0;
    let cancelled = false;

    center.addEventListener("pointerdown", (e) => {
      downX = e.clientX;
      downY = e.clientY;
      downTime = Date.now();
      cancelled = false;
      try { center.setPointerCapture(e.pointerId); } catch (_) {}
    });
    center.addEventListener("pointermove", (e) => {
      if (downX === null) return;
      // If the user starts a clearly vertical drag, give up — they're probably
      // trying to scroll the page.
      if (!cancelled && Math.abs(e.clientY - downY) > 60 && Math.abs(e.clientX - downX) < 20) {
        cancelled = true;
      }
    });
    center.addEventListener("pointerup", (e) => {
      if (downX === null) return;
      const dx = e.clientX - downX;
      const wasCancelled = cancelled;
      downX = downY = null; downTime = 0; cancelled = false;
      try { center.releasePointerCapture(e.pointerId); } catch (_) {}
      if (wasCancelled) return;
      this._toggleHelp(false);
      if (Math.abs(dx) >= SWIPE_THRESHOLD) {
        if (dx < 0) { this._flashZone(ICON.speedDown); this._cycleSpeed(-1); }
        else        { this._flashZone(ICON.speedUp);   this._cycleSpeed(+1); }
      } else {
        this._handleZone("center");
      }
    });
    center.addEventListener("pointercancel", () => {
      downX = downY = null; downTime = 0; cancelled = false;
    });

    // Controls.
    this.$playBtn.addEventListener("click", (e) => { e.stopPropagation(); this._togglePlay(); });
    this.$muteBtn.addEventListener("click", () => { v.muted = !v.muted; });
    this.$volume.addEventListener("input", () => { v.muted = false; v.volume = parseFloat(this.$volume.value); });
    this.$speed.addEventListener("click", () => this._cycleSpeed(+1));
    this.$speed.addEventListener("contextmenu", (e) => { e.preventDefault(); this._cycleSpeed(-1); });
    this.$fsBtn.addEventListener("click", () => this._toggleFullscreen());
    this.$pipBtn.addEventListener("click", () => this._togglePip());
    this.$helpBtn.addEventListener("click", () => this._toggleHelp());
    this.$help.addEventListener("click", (e) => {
      if (!e.target.closest(".vp-help-card")) this._toggleHelp(false);
    });

    // Timeline pointer (scrub or shot-drag — delegated).
    this.$timeline.addEventListener("pointerdown", (e) => this._onTimelinePointerDown(e));
    this.$timeline.addEventListener("pointermove", (e) => this._onTimelinePointerMove(e));
    window.addEventListener("pointermove", (e) => this._onTimelinePointerMove(e, true));
    window.addEventListener("pointerup",   (e) => this._onTimelinePointerUp(e));
    window.addEventListener("pointercancel", (e) => this._onTimelinePointerUp(e));

    // Delete-X on a clip handle. Stop propagation so the underlying drag
    // doesn't kick in.
    this.$shotsBox.addEventListener("click", (e) => {
      const del = e.target.closest(".vp-handle-del");
      if (!del) return;
      e.stopPropagation();
      this._deleteShot(parseInt(del.dataset.i, 10));
    });

    // Keyboard.
    this.$root.addEventListener("keydown", (e) => this._onKey(e));

    // Fullscreen sync.
    document.addEventListener("fullscreenchange", () => {
      const isFs = document.fullscreenElement === this;
      this.$root.classList.toggle("is-fullscreen", isFs);
      this.$fsBtn.innerHTML = isFs ? ICON.exitFullscreen : ICON.fullscreen;
    });
  }

  // ─── Time / playback ───────────────────────────────────────────────────────

  _togglePlay() {
    if (!this.$video.src) return;
    if (this.$video.paused) this.$video.play().catch(() => {});
    else this.$video.pause();
  }

  // ─── Tap-zone routing ──────────────────────────────────────────────────────

  _handleZone(action) {
    switch (action) {
      case "prev-clip":  this._flashZone(ICON.skipBack);    this._prevClip(); break;
      case "next-clip":  this._flashZone(ICON.skipForward); this._nextClip(); break;
      case "center": {
        const mode = (this.getAttribute("center-action") || "pause").toLowerCase();
        if (mode === "back") {
          this._flashZone(ICON.back);
          this._back();
        } else {
          // Show the destination icon — what you'll be in after the tap.
          this._flashZone(this.$video.paused ? ICON.play : ICON.pause);
          this._togglePlay();
        }
        break;
      }
    }
  }

  _flashZone(svg) {
    if (!this.$zoneFlash) return;
    this.$zoneFlash.innerHTML = svg;
    this.$zoneFlash.classList.remove("is-visible");
    // Force reflow so the animation restarts on rapid taps.
    void this.$zoneFlash.offsetWidth;
    this.$zoneFlash.classList.add("is-visible");
    clearTimeout(this._flashTimer);
    this._flashTimer = setTimeout(() => this.$zoneFlash.classList.remove("is-visible"), 450);
  }

  _navigate(eventName, hrefAttr) {
    const evt = new CustomEvent(eventName, { cancelable: true, bubbles: true, composed: true });
    const allow = this.dispatchEvent(evt);
    if (!allow) return false;
    const href = this.getAttribute(hrefAttr);
    if (href) { location.href = href; return true; }
    return false;
  }

  // Walk through shots first; if nothing matches, wrap around to the last/
  // first shot. Only fall back to host-supplied prev/next URLs (or a no-op
  // toast) when there are no shots at all.
  _prevClip() {
    if (this._shots.length === 0) {
      if (!this._navigate("prev-clip", "prev-href")) this._toast("No previous clip");
      return;
    }
    const t = this.$video.currentTime;
    const epsilon = 1.0;       // "you're definitely past the start" threshold
    let target = -1;
    for (let i = 0; i < this._shots.length; i++) {
      // Last shot whose start is at least `epsilon` behind us wins. If we're
      // partway through the current shot, that shot's own start is the target
      // — pressing prev "rewinds" the current clip.
      if (this._shots[i].start <= t - epsilon) target = i;
    }
    if (target < 0) target = this._shots.length - 1;  // wrap to last
    this._playShot(target);
  }

  _nextClip() {
    if (this._shots.length === 0) {
      if (!this._navigate("next-clip", "next-href")) this._toast("No next clip");
      return;
    }
    const t = this.$video.currentTime;
    let target = this._shots.findIndex((s) => s.start > t + 0.05);
    if (target < 0) target = 0;                        // wrap to first
    this._playShot(target);
  }

  _back() {
    const evt = new CustomEvent("back", { cancelable: true, bubbles: true, composed: true });
    const allow = this.dispatchEvent(evt);
    if (!allow) return;
    const href = this.getAttribute("back-href");
    if (href) location.href = href;
    else if (window.history.length > 1) window.history.back();
  }

  _onTimeUpdate() {
    this._renderProgress();
    if (this._stopAt !== null && this.$video.currentTime >= this._stopAt) {
      this.$video.pause();
      this._stopAt = null;
    }
  }

  _cycleSpeed(dir) {
    const i = SPEEDS.indexOf(this.$video.playbackRate);
    const next = SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + dir))];
    this.$video.playbackRate = next;
    this._toast(`${next}×`);
  }

  _stepFrame(dir) {
    const dt = 1 / (this._frameRate || 30);
    this.$video.pause();
    this.$video.currentTime = Math.max(0, Math.min(this.$video.duration || Infinity, this.$video.currentTime + dir * dt));
  }

  _seek(delta) {
    if (!isFinite(this.$video.duration)) return;
    this.$video.currentTime = Math.max(0, Math.min(this.$video.duration, this.$video.currentTime + delta));
  }

  _seekTo(frac) {
    if (!isFinite(this.$video.duration)) return;
    this.$video.currentTime = this.$video.duration * frac;
  }

  // ─── Marks & shots ─────────────────────────────────────────────────────────

  _setMarkIn(t)  {
    this._pendingIn = +t.toFixed(3);
    if (this._pendingOut !== null && this._pendingOut <= this._pendingIn) this._pendingOut = null;
    this._renderMarks();
    this._toast(`In  ${fmtTime(t, { ms: true })}`);
  }
  _setMarkOut(t) {
    this._pendingOut = +t.toFixed(3);
    if (this._pendingIn !== null && this._pendingIn >= this._pendingOut) this._pendingIn = null;
    this._renderMarks();
    this._toast(`Out ${fmtTime(t, { ms: true })}`);
  }
  _clearMarks() {
    this._pendingIn = null;
    this._pendingOut = null;
    this._renderMarks();
  }
  _commitMarks() {
    if (this._pendingIn === null || this._pendingOut === null) return;
    if (this._pendingOut <= this._pendingIn) return;
    this._addShot(this._pendingIn, this._pendingOut);
    this._clearMarks();
  }

  // ─── Inactive ↔ active clips ───────────────────────────────────────────────
  // Single state machine. New clips born from a seek are inactive (grey).
  // Any edit (resize, move) flips them to active (red).

  _activateClip(idx) {
    const s = this._shots[idx];
    if (!s || s.active) return;
    this._shots[idx] = { ...s, active: true };
  }

  // Internal helper used by the seek-creates-clip flow. Adding a new inactive
  // clip replaces any existing inactive — at most one grey clip exists at a
  // time. Active clips are left alone.
  _addClip(start, end, active = false) {
    const clip = {
      start:  +start.toFixed(3),
      end:    +end.toFixed(3),
      active: !!active,
    };
    const base = active ? this._shots : this._shots.filter((s) => s.active);
    this._shots = [...base, clip].sort((a, b) => a.start - b.start);
    this._renderShots();
    this._renderShotChips();
    this._emitChange(active ? "add" : "mark");
  }

  // Backwards-compat: external callers may still use _addShot to push an
  // already-active clip (e.g. a future API caller).
  _addShot(start, end, label) {
    const clip = { start: +start.toFixed(3), end: +end.toFixed(3), active: true };
    if (label) clip.label = label;
    this._shots = [...this._shots, clip].sort((a, b) => a.start - b.start);
    this._renderShots();
    this._renderShotChips();
    this._emitChange("add");
    this._toast("+ clip");
  }

  _deleteShot(i) {
    if (i < 0 || i >= this._shots.length) return;
    this._shots = this._shots.filter((_, idx) => idx !== i);
    this._renderShots();
    this._renderShotChips();
    this._emitChange("delete");
  }

  _playShot(i) {
    const shot = this._shots[i];
    if (!shot) return;
    this.$video.currentTime = shot.start;
    this._stopAt = shot.end;
    this.$video.muted = false;
    this.$video.play().catch(() => {});
  }

  _emitChange(kind) {
    const detail = {
      shots:   this.shots,
      markers: this.markers,
      items:   this.items,
      kind,
    };
    // Don't double-emit if nothing actually changed (e.g. drag with same end value).
    const sig = JSON.stringify(detail.items);
    if (sig === this._lastEmitted) return;
    this._lastEmitted = sig;
    this.dispatchEvent(new CustomEvent("shots-change", {
      detail, bubbles: true, composed: true,
    }));
  }

  // ─── Pointer / scrubbing ───────────────────────────────────────────────────

  _trackRect() { return this.$track.getBoundingClientRect(); }
  _xToTime(clientX) {
    const r = this._trackRect();
    const frac = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return frac * (this.$video.duration || 0);
  }

  _onTimelinePointerDown(e) {
    if (!isFinite(this.$video.duration)) return;

    // Delete-X is handled via click; don't grab the pointer.
    if (e.target.closest(".vp-handle-del")) return;

    // Active-shot drag handles / move come first.
    const handle = e.target.closest(".vp-shot-handle");
    const shotEl = e.target.closest(".vp-shot");
    if (handle && shotEl) {
      const idx = parseInt(shotEl.dataset.i, 10);
      const side = handle.classList.contains("left") ? "shot-resize-l" : "shot-resize-r";
      const s = this._shots[idx];
      this._scrubbing = {
        type: side, shotIndex: idx, downX: e.clientX, moved: false,
        wasPlaying: !this.$video.paused,
      };
      this.$timeline.classList.add("is-scrubbing");
      this.$timeline.setPointerCapture?.(e.pointerId);
      this.$video.pause();
      // Snap immediately so you see the current frame at the handle's anchor.
      if (s) this.$video.currentTime = side === "shot-resize-l" ? s.start : s.end;
      e.preventDefault(); e.stopPropagation();
      return;
    }
    if (shotEl) {
      const idx = parseInt(shotEl.dataset.i, 10);
      const t  = this._xToTime(e.clientX);
      this._scrubbing = {
        type: "shot-move", shotIndex: idx, anchor: t - this._shots[idx].start,
        downX: e.clientX, moved: false,
        wasPlaying: !this.$video.paused,
      };
      this.$timeline.classList.add("is-scrubbing");
      this.$timeline.setPointerCapture?.(e.pointerId);
      this.$video.pause();
      e.preventDefault(); e.stopPropagation();
      return;
    }

    // Plain seek scrub. We track the original X so pointer-up can tell whether
    // it was a tap (just seek) or a drag (seek + drop a marker).
    this._scrubbing = {
      type: "seek",
      wasPlaying: !this.$video.paused,
      downX: e.clientX,
      moved: false,
    };
    this.$timeline.classList.add("is-scrubbing");
    this.$timeline.setPointerCapture?.(e.pointerId);
    this.$video.pause();
    this.$video.currentTime = this._xToTime(e.clientX);
    e.preventDefault();
  }

  _onTimelinePointerMove(e, fromWindow) {
    // Hover tip — even when not scrubbing — but only for events on the timeline itself.
    if (!fromWindow) {
      const t = this._xToTime(e.clientX);
      const r = this._trackRect();
      this.$hoverTip.textContent = fmtTime(t);
      this.$hoverTip.style.left = `${e.clientX - r.left}px`;
    }
    if (!this._scrubbing) return;
    const t = this._xToTime(e.clientX);
    const dur = this.$video.duration || 0;
    if (this._scrubbing.type === "seek") {
      this.$video.currentTime = t;
      // Only a deliberate "I'm positioning" drag drops a clip. A short tap or
      // small wiggle just seeks. 20px is a comfortable threshold — small enough
      // not to feel sluggish, big enough to filter accidental clips.
      if (typeof this._scrubbing.downX === "number" && Math.abs(e.clientX - this._scrubbing.downX) > 20) {
        this._scrubbing.moved = true;
      }
    } else if (this._scrubbing.type === "shot-move") {
      if (typeof this._scrubbing.downX === "number" && Math.abs(e.clientX - this._scrubbing.downX) > 5) {
        this._scrubbing.moved = true;
      }
      const i = this._scrubbing.shotIndex;
      const s = this._shots[i];
      const len = s.end - s.start;
      const ns = Math.max(0, Math.min(dur - len, t - this._scrubbing.anchor));
      this._shots[i] = { ...s, start: +ns.toFixed(3), end: +(ns + len).toFixed(3) };
      this.$video.currentTime = ns;          // live frame at the new start
      this._renderShots();
    } else if (this._scrubbing.type === "shot-resize-l") {
      const i = this._scrubbing.shotIndex;
      const s = this._shots[i];
      const ns = Math.max(0, Math.min(s.end - 0.05, t));
      this._shots[i] = { ...s, start: +ns.toFixed(3) };
      this.$video.currentTime = ns;          // see the frame at the start handle
      this._renderShots();
    } else if (this._scrubbing.type === "shot-resize-r") {
      const i = this._scrubbing.shotIndex;
      const s = this._shots[i];
      const ne = Math.max(s.start + 0.05, Math.min(dur, t));
      this._shots[i] = { ...s, end: +ne.toFixed(3) };
      this.$video.currentTime = ne;          // see the frame at the end handle
      this._renderShots();
    }
  }

  _onTimelinePointerUp(e) {
    if (!this._scrubbing) return;
    this.$timeline.classList.remove("is-scrubbing");
    try { this.$timeline.releasePointerCapture?.(e.pointerId); } catch (_) {}
    const scrub = this._scrubbing;
    const type = scrub.type;

    this._scrubbing = null;

    if (type === "seek") {
      if (scrub.moved) {
        // Deliberate positioning drag (>20px) drops a fresh inactive grey clip
        // on the new playhead — _addClip already replaces any prior inactive.
        const t = this.$video.currentTime;
        const dur = this.$video.duration || 0;
        if (dur > 0) {
          const start = Math.max(0, Math.min(dur - 0.1, t));
          const end   = Math.min(dur, start + 0.5);   // short stub
          this._addClip(start, end, false);
        }
      } else {
        // Short tap on empty track: just seek, and clear any inactive clip.
        const before = this._shots.length;
        this._shots = this._shots.filter((s) => s.active);
        if (this._shots.length !== before) {
          this._renderShots();
          this._renderShotChips();
          this._emitChange("clear-inactive");
        }
      }
      if (scrub.wasPlaying) this.$video.play().catch(() => {});
      return;
    }

    if (type === "shot-move") {
      if (!scrub.moved) {
        // Plain tap on a clip range = play that clip.
        this._playShot(scrub.shotIndex);
      } else {
        this._activateClip(scrub.shotIndex);
        this._shots = this._shots.slice().sort((a, b) => a.start - b.start);
        this._renderShots();
        this._renderShotChips();
        this._emitChange("edit");
        if (scrub.wasPlaying) this.$video.play().catch(() => {});
      }
      return;
    }

    if (type === "shot-resize-l" || type === "shot-resize-r") {
      this._activateClip(scrub.shotIndex);
      this._shots = this._shots.slice().sort((a, b) => a.start - b.start);
      this._renderShots();
      this._renderShotChips();
      this._emitChange("edit");
      if (scrub.wasPlaying) this.$video.play().catch(() => {});
      return;
    }
  }

  // ─── Keyboard ──────────────────────────────────────────────────────────────

  _onKey(e) {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
    const k = e.key;
    const shift = e.shiftKey;
    const noMod = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (!noMod && !(shift && (k === "ArrowLeft" || k === "ArrowRight" || k === "I" || k === "O"))) return;

    let handled = true;
    switch (k) {
      case " ":
      case "k":
      case "K":
        this._togglePlay(); break;
      case "j":
      case "J":
        this._seek(-10); break;
      case "l":
      case "L":
        this._seek(+10); break;
      case "ArrowLeft":  this._seek(shift ? -1 : -5); break;
      case "ArrowRight": this._seek(shift ? +1 : +5); break;
      case ",": this._stepFrame(-1); break;
      case ".": this._stepFrame(+1); break;
      case "m":
      case "M":
        this.$video.muted = !this.$video.muted; break;
      case "f":
      case "F":
        this._toggleFullscreen(); break;
      case "p":
      case "P":
        this._togglePip(); break;
      case "<":
        this._cycleSpeed(-1); break;
      case ">":
        this._cycleSpeed(+1); break;
      case "i":
        this._setMarkIn(this.$video.currentTime); break;
      case "I":
        if (this._pendingIn !== null) this.$video.currentTime = this._pendingIn;
        else this._setMarkIn(this.$video.currentTime);
        break;
      case "o":
        this._setMarkOut(this.$video.currentTime); break;
      case "O":
        if (this._pendingOut !== null) this.$video.currentTime = this._pendingOut;
        else this._setMarkOut(this.$video.currentTime);
        break;
      case "Enter":
        this._commitMarks();
        break;
      case "Escape":
        if (this.$help.classList.contains("is-visible")) this._toggleHelp(false);
        else this._clearMarks();
        break;
      case "?": this._toggleHelp(); break;
      default:
        if (/^[0-9]$/.test(k)) this._seekTo(parseInt(k, 10) / 10);
        else handled = false;
    }
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }

  // ─── Fullscreen / PiP ──────────────────────────────────────────────────────

  _toggleFullscreen() {
    if (document.fullscreenElement === this) document.exitFullscreen();
    else if (this.requestFullscreen) this.requestFullscreen();
    else if (this.$video.webkitEnterFullscreen) this.$video.webkitEnterFullscreen(); // iOS Safari
  }

  async _togglePip() {
    try {
      if (document.pictureInPictureElement === this.$video) await document.exitPictureInPicture();
      else await this.$video.requestPictureInPicture();
    } catch (err) { console.warn("[vig-player] PiP failed", err); }
  }

  _toggleHelp(force) {
    const v = (typeof force === "boolean") ? force : !this.$help.classList.contains("is-visible");
    this.$help.classList.toggle("is-visible", v);
  }

  // ─── Render helpers ────────────────────────────────────────────────────────

  _sync() {
    this._renderProgress();
    this._renderBuffer();
    this._renderVolume();
    this._renderSpeed();
    this._renderShots();
    this.$dur.textContent = fmtTime(this.$video.duration || 0);
  }

  _renderProgress() {
    const dur = this.$video.duration || 0;
    const t = this.$video.currentTime || 0;
    const pct = dur > 0 ? Math.min(100, (t / dur) * 100) : 0;
    this.$progress.style.width = pct + "%";
    this.$thumb.style.left = pct + "%";
    this.$now.textContent = fmtTime(t);
  }

  _renderBuffer() {
    const dur = this.$video.duration || 0;
    if (!dur) { this.$buffer.style.width = "0"; return; }
    const buf = this.$video.buffered;
    if (!buf.length) { this.$buffer.style.width = "0"; return; }
    // Find buffered range that contains current time.
    const t = this.$video.currentTime;
    let end = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf.start(i) <= t && buf.end(i) >= t) { end = buf.end(i); break; }
      end = Math.max(end, buf.end(i));
    }
    this.$buffer.style.width = ((end / dur) * 100) + "%";
  }

  _renderVolume() {
    const v = this.$video;
    this.$muteBtn.innerHTML = v.muted || v.volume === 0 ? ICON.volumeOff : ICON.volumeOn;
    this.$volume.value = v.muted ? 0 : v.volume;
  }

  _renderSpeed() {
    const r = this.$video.playbackRate;
    this.$speed.textContent = (r === 1 ? "1×" : r + "×");
  }

  _renderMarks() {
    if (!this.$video || !this.$markIn) return;
    const dur = this.$video.duration || 0;
    if (!dur) return;
    const place = (el, t) => {
      if (t === null) { el.hidden = true; return; }
      el.hidden = false;
      el.style.left = (t / dur) * 100 + "%";
    };
    place(this.$markIn, this._pendingIn);
    place(this.$markOut, this._pendingOut);
    if (this._pendingIn !== null && this._pendingOut !== null && this._pendingOut > this._pendingIn) {
      this.$markRng.hidden = false;
      this.$markRng.style.left  = (this._pendingIn / dur) * 100 + "%";
      this.$markRng.style.width = ((this._pendingOut - this._pendingIn) / dur) * 100 + "%";
    } else {
      this.$markRng.hidden = true;
    }
  }

  _renderShots() {
    if (!this.$video || !this.$shotsBox) return;
    const dur = this.$video.duration || 0;
    this.$shotsBox.innerHTML = "";
    if (!dur) return;

    this._shots.forEach((s, i) => {
      const el = document.createElement("div");
      el.className = "vp-shot " + (s.active ? "is-active" : "is-inactive");
      el.dataset.i = i;
      el.style.left  = (s.start / dur) * 100 + "%";
      el.style.width = Math.max(0.4, ((s.end - s.start) / dur) * 100) + "%";
      el.title = `${fmtTime(s.start)} – ${fmtTime(s.end)}`;
      el.innerHTML = `
        <div class="vp-shot-handle left">
          <span class="vp-handle-del" data-i="${i}" role="button" aria-label="Delete clip">×</span>
        </div>
        <div class="vp-shot-handle right"></div>
      `;
      this.$shotsBox.appendChild(el);
    });

    this._renderMarks();
  }

  _renderShotChips() {
    // The chip panel was removed in favour of pins on the timeline. Kept as a
    // no-op so internal callers don't have to branch.
  }

  // ─── Toast ─────────────────────────────────────────────────────────────────

  _toast(msg) {
    if (!this.$toast) return;
    this.$toast.textContent = msg;
    this.$toast.classList.add("is-visible");
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => this.$toast.classList.remove("is-visible"), 900);
  }
}

if (!customElements.get("vig-player")) {
  customElements.define("vig-player", VigPlayer);
}

export default VigPlayer;
export { VigPlayer };
