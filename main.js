import { FlipFluid, PANEL_W, PANEL_H } from "./flip.js";
import { centerOnPanel, letterTable, countCode, floodFill } from "./bead.js";
import { MARD_PALETTE, MARD_BY_CODE, MARD_SERIES } from "./mard-palette.js";

const LED_CELL = 20; // on-screen pixels per LED, keeps 16×16 as a true square grid
const canvas = document.getElementById("led");
if (!canvas) throw new Error("找不到灯板画布，请从 web/index.html 或 启动网页.cmd 打开");
canvas.width = PANEL_W * LED_CELL;
canvas.height = PANEL_H * LED_CELL;
const ctx = canvas.getContext("2d", { alpha: false });
const bottle = document.getElementById("bottle");
const needle = document.getElementById("needle");
const btnRotate = document.getElementById("btnRotate");
const btnReset = document.getElementById("btnReset");
const swatch = document.getElementById("swatch");
const angleLabel = document.getElementById("angleLabel");
const particleLabel = document.getElementById("particleLabel");
const gridLabel = document.getElementById("gridLabel");
if (gridLabel) gridLabel.textContent = `${PANEL_W}×${PANEL_H}`;

const $ = (id) => document.getElementById(id);

const state = {
  fluid: new FlipFluid(PANEL_W, PANEL_H, 0.6),
  fps: 30,
  fill: 0.6,
  lastFill: 0.6,
  angle: -90,
  rotateOn: false,
  rotateSpeed: 45,
  blue: 180,
  cr: 40,
  cg: 200,
  cb: 230,
  previewGain: 8,
  beads: null,
  litCodes: new Set(),
  sourcePalette: Object.fromEntries(MARD_PALETTE.map((c) => [c.code, c.rgb.slice()])),
  paintCode: "A5",
  editTool: "paint",
  seriesFilter: "all",
  colorQuery: "",
  replaceFrom: "",
  history: [],
  patterns: [],
  currentPatternId: null,
  patternDirty: false,
};

const PATTERN_STORE_KEY = "pindo-ocean-patterns-v1";

function clonePalette(palette) {
  const next = {};
  for (const [code, rgb] of Object.entries(palette || {})) {
    if (rgb) next[code] = rgb.slice();
  }
  return next;
}

function patternHasPixels(rows) {
  if (!rows?.length) return false;
  for (const row of rows) {
    for (const code of row) {
      if (code && code !== ".") return true;
    }
  }
  return false;
}

function snapshotBoard() {
  const beads = state.beads;
  if (!beads) return { rows: [], palette: {} };
  const used = {};
  for (const row of beads.rows) {
    for (const code of row) {
      if (!code || code === ".") continue;
      used[code] = (beads.palette[code] || state.sourcePalette[code] || MARD_BY_CODE.get(code)?.rgb)?.slice();
    }
  }
  return { rows: cloneRows(beads.rows), palette: used };
}

function defaultPatternName() {
  const typed = $("patternName")?.value.trim();
  if (typed) return typed;
  return `图案 ${state.patterns.length + 1}`;
}

function persistPatterns() {
  try {
    localStorage.setItem(
      PATTERN_STORE_KEY,
      JSON.stringify({
        patterns: state.patterns,
        lastId: state.currentPatternId,
      }),
    );
  } catch {
    setBeadStatus("保存失败：浏览器存储已满或不可用。");
  }
}

function loadStoredPatterns() {
  try {
    const raw = localStorage.getItem(PATTERN_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    const list = Array.isArray(data) ? data : data.patterns;
    if (!Array.isArray(list)) return;
    state.patterns = list.filter((p) => p && p.id && Array.isArray(p.rows));
    if (!Array.isArray(data) && data.lastId) state.currentPatternId = data.lastId;
  } catch {
    state.patterns = [];
  }
}

function markPatternDirty() {
  state.patternDirty = true;
}

function formatPatternTime(ts) {
  try {
    return new Date(ts).toLocaleString("zh-CN", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function occupiedBounds(rows) {
  const h = rows?.length || 0;
  const w = h ? rows[0].length : 0;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const code = rows[y][x];
      if (!code || code === ".") continue;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return { x0: 0, y0: 0, w, h };
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

function drawPatternThumb(canvas, rows, palette) {
  const size = 40;
  canvas.width = size;
  canvas.height = size;
  const c = canvas.getContext("2d");
  c.fillStyle = "#14282c";
  c.fillRect(0, 0, size, size);
  const h = rows?.length || 0;
  const w = h ? rows[0].length : 0;
  if (!w || !h) return;
  const box = occupiedBounds(rows);
  const cell = (size - 4) / Math.max(box.w, box.h, 1);
  const ox = (size - box.w * cell) / 2;
  const oy = (size - box.h * cell) / 2;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const code = rows[box.y0 + y][box.x0 + x];
      const rgb = code && code !== "." ? palette?.[code] : null;
      c.fillStyle = rgb ? `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})` : "#1c3338";
      c.fillRect(ox + x * cell, oy + y * cell, Math.max(1, cell - 0.4), Math.max(1, cell - 0.4));
    }
  }
}

function renderPatternList() {
  const list = $("patternList");
  if (!list) return;
  list.replaceChildren();
  for (const item of state.patterns) {
    const row = document.createElement("div");
    row.className = `pattern-item${item.id === state.currentPatternId ? " is-on" : ""}`;
    row.tabIndex = 0;
    row.title = "点选切换到此图案";
    row.setAttribute("aria-label", item.name || "未命名图案");
    const thumb = document.createElement("canvas");
    drawPatternThumb(thumb, item.rows, item.palette);
    const meta = document.createElement("span");
    meta.className = "pattern-meta";
    const name = document.createElement("span");
    name.className = "pattern-name";
    name.textContent = item.name || "未命名";
    const time = document.createElement("span");
    time.className = "pattern-time";
    time.textContent = formatPatternTime(item.savedAt);
    meta.append(name, time);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "pattern-del";
    del.textContent = "删除";
    del.title = "删除此图案";
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteSavedPattern(item.id);
    });
    row.append(thumb, meta, del);
    const open = () => switchSavedPattern(item.id);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
    list.append(row);
  }
}

function saveCurrentPattern(asNew) {
  const shot = snapshotBoard();
  if (!patternHasPixels(shot.rows)) {
    setBeadStatus("格子是空的，画一点再保存。");
    return;
  }
  const name = defaultPatternName();
  const now = Date.now();
  if (!asNew && state.currentPatternId) {
    const existing = state.patterns.find((p) => p.id === state.currentPatternId);
    if (existing) {
      existing.name = name;
      existing.rows = shot.rows;
      existing.palette = shot.palette;
      existing.savedAt = now;
      state.patternDirty = false;
      persistPatterns();
      renderPatternList();
      setBeadStatus(`已更新「${name}」。点列表即可切换图案。`);
      return;
    }
  }
  const entry = {
    id: `p-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    name,
    rows: shot.rows,
    palette: shot.palette,
    savedAt: now,
  };
  state.patterns.unshift(entry);
  state.currentPatternId = entry.id;
  state.patternDirty = false;
  if ($("patternName")) $("patternName").value = name;
  persistPatterns();
  renderPatternList();
  setBeadStatus(`已保存「${name}」。之后可在列表里点选切换。`);
}

function switchSavedPattern(id) {
  if (id === state.currentPatternId && !state.patternDirty) return;
  if (state.patternDirty && !confirm("当前图案还没保存，确定切换？未保存的修改会丢掉。")) return;
  const item = state.patterns.find((p) => p.id === id);
  if (!item) return;
  applyBeadPattern(
    { rows: cloneRows(item.rows), palette: clonePalette(item.palette) },
    `已切换到「${item.name}」`,
    { id: item.id, name: item.name },
  );
  persistPatterns();
}

function deleteSavedPattern(id) {
  const item = state.patterns.find((p) => p.id === id);
  if (!item) return;
  if (!confirm(`删除「${item.name}」？`)) return;
  state.patterns = state.patterns.filter((p) => p.id !== id);
  if (state.currentPatternId === id) {
    applyBeadPattern({ rows: [], palette: state.sourcePalette }, "已删除图案，回到空白板。", {
      id: null,
      name: "",
    });
  }
  persistPatterns();
  renderPatternList();
}

function restoreLastPattern() {
  const item = state.patterns.find((p) => p.id === state.currentPatternId);
  if (!item) {
    state.currentPatternId = null;
    return;
  }
  applyBeadPattern(
    { rows: cloneRows(item.rows), palette: clonePalette(item.palette) },
    `已载入「${item.name}」`,
    { id: item.id, name: item.name },
  );
}

function startNewPattern() {
  if (state.patternDirty && !confirm("当前图案还没保存，确定新建？未保存的修改会丢掉。")) return;
  applyBeadPattern({ rows: [], palette: state.sourcePalette }, "已新建空白板。画完后点保存，不会覆盖旧图案。", {
    id: null,
    name: "",
  });
}

function bindRange(id, valueId, format, onChange) {
  const el = $(id);
  const lab = $(valueId);
  const sync = () => {
    const v = Number(el.value);
    lab.textContent = format(v);
    onChange(v);
  };
  el.addEventListener("input", sync);
  sync();
  return el;
}

bindRange("tilt", "v-tilt", (v) => `${Math.round(v)}°`, (v) => {
  if (!state.rotateOn) state.angle = v;
});
bindRange("rspeed", "v-rspeed", (v) => `${Math.round(v)}°/s`, (v) => {
  state.rotateSpeed = v;
});
bindRange("fps", "v-fps", (v) => `${Math.round(v)}`, (v) => {
  state.fps = v;
});
bindRange("fill", "v-fill", (v) => v.toFixed(2), (v) => {
  state.fill = v;
});
bindRange("blue", "v-blue", (v) => `${Math.round(v)}`, (v) => {
  state.blue = v;
});
bindRange("cr", "v-cr", (v) => `${Math.round(v)}`, (v) => {
  state.cr = v;
  updateSwatch();
});
bindRange("cg", "v-cg", (v) => `${Math.round(v)}`, (v) => {
  state.cg = v;
  updateSwatch();
});
bindRange("cb", "v-cb", (v) => `${Math.round(v)}`, (v) => {
  state.cb = v;
  updateSwatch();
});
bindRange("clamp", "v-clamp", (v) => v.toFixed(2), (v) => {
  state.fluid.densityClamp = v;
});
bindRange("gamma", "v-gamma", (v) => v.toFixed(2), (v) => {
  state.fluid.setGamma(v);
});
bindRange("grav", "v-grav", (v) => v.toFixed(2), (v) => {
  state.fluid.gravityScale = v;
});
bindRange("press", "v-press", (v) => `${Math.round(v)}`, (v) => {
  state.fluid.pressureIters = Math.round(v);
});
bindRange("flip", "v-flip", (v) => v.toFixed(2), (v) => {
  state.fluid.flipRatio = v;
});

function updateSwatch() {
  swatch.style.background = `rgb(${state.cr}, ${state.cg}, ${state.cb})`;
}
updateSwatch();

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    document.getElementById(`pane-${btn.dataset.tab}`).classList.add("active");
  });
});

function setRotate(on) {
  state.rotateOn = on;
  btnRotate.classList.toggle("is-on", on);
  btnRotate.textContent = on ? "旋转中 — 再点停止" : "旋转瓶子";
  bottle.classList.toggle("is-spinning", on);
}

/** Upright tilt -90° → CSS rotate 0°. Bottle follows the tilt slider directly. */
function visualBottleDeg(angle) {
  return angle + 90;
}

/**
 * Real bottle tip: walls rotate one way, gravity in bottle frame goes the other way.
 * Around upright (-90°): waterAngle = -180 - tilt
 * e.g. tilt -100° → water -80°; tilt -80° → water -100°.
 */
function waterAngleFromTilt(tilt) {
  return -180 - tilt;
}

btnRotate.addEventListener("click", () => setRotate(!state.rotateOn));

function seriesOf(code) {
  return (String(code).match(/^[A-Z]+/) || ["A"])[0];
}

function paintRgb(code) {
  return MARD_BY_CODE.get(code)?.rgb || state.sourcePalette[code] || null;
}

function syncPaintSwatch() {
  const swatch = $("paintSwatch");
  const rgb = paintRgb(state.paintCode);
  if (swatch && rgb) swatch.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
  const count = $("paletteCount");
  if (count) count.textContent = `Pindo MARD ${MARD_PALETTE.length} 色`;
}

function selectPaintColor(code) {
  state.paintCode = code;
  if (state.editTool === "erase") setEditTool("paint");
  syncPaintSwatch();
  const verb =
    state.editTool === "recolor"
      ? `再点格子上的色块，整块换成 ${code}`
      : `点一次上色，再点同一格熄灭（当前 ${code}）`;
  setBeadStatus(`已选 ${code}。${verb}。`);
  renderColorPicker();
}

function renderColorPicker() {
  const tabs = $("seriesTabs");
  const picker = $("colorPicker");
  if (!tabs || !picker) return;
  const query = state.colorQuery.trim().toUpperCase();
  const seriesList = ["all", ...MARD_SERIES];
  tabs.replaceChildren();
  for (const series of seriesList) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = series === "all" ? "全部" : series;
    btn.className = !query && state.seriesFilter === series ? "is-on" : "";
    btn.addEventListener("click", () => {
      state.seriesFilter = series;
      state.colorQuery = "";
      if ($("colorSearch")) $("colorSearch").value = "";
      renderColorPicker();
    });
    tabs.append(btn);
  }
  const colors = MARD_PALETTE.filter((color) => {
    if (query) return color.code.toUpperCase().includes(query);
    if (state.seriesFilter === "all") return true;
    return seriesOf(color.code) === state.seriesFilter;
  });
  picker.classList.toggle("is-all", Boolean(query) || state.seriesFilter === "all");
  picker.replaceChildren();
  for (const color of colors) {
    const wrap = document.createElement("div");
    wrap.className = "color-chip-wrap";
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `color-chip${state.paintCode === color.code ? " is-paint" : ""}`;
    chip.title = color.code;
    chip.setAttribute("aria-label", color.code);
    chip.style.background = `rgb(${color.rgb[0]}, ${color.rgb[1]}, ${color.rgb[2]})`;
    chip.addEventListener("click", () => selectPaintColor(color.code));
    const cap = document.createElement("span");
    cap.textContent = color.code;
    wrap.append(chip, cap);
    picker.append(wrap);
  }
  syncPaintSwatch();
}

$("colorSearch")?.addEventListener("input", (event) => {
  state.colorQuery = event.target.value;
  renderColorPicker();
});

$("replaceFrom")?.addEventListener("change", (event) => {
  state.replaceFrom = event.target.value;
});

$("btnReplaceAll")?.addEventListener("click", () => {
  if (state.editTool === "erase") setEditTool("recolor");
  const from = state.replaceFrom || $("replaceFrom")?.value;
  if (!from) {
    setBeadStatus("请先选要替换的已用色，再从 377 色里选新颜色。");
    return;
  }
  if (!state.paintCode) {
    setBeadStatus("请从 377 色板里选择要换成的颜色。");
    return;
  }
  replaceAllColors(from, state.paintCode);
});

$("btnClearBead")?.addEventListener("click", () => {
  state.history = [];
  state.litCodes = new Set();
  state.beads = centerOnPanel([], PANEL_W, PANEL_H, state.sourcePalette);
  markPatternDirty();
  refreshBeadDisplay();
  setBeadStatus("已清空 16×16。从 377 色里选颜色再点格子。");
});

$("btnSavePattern")?.addEventListener("click", () => saveCurrentPattern(false));
$("btnSaveAsPattern")?.addEventListener("click", () => saveCurrentPattern(true));
$("btnNewPattern")?.addEventListener("click", () => startNewPattern());

function setEditTool(tool) {
  state.editTool = tool;
  $("toolPaint")?.classList.toggle("is-on", tool === "paint");
  $("toolRecolor")?.classList.toggle("is-on", tool === "recolor");
  $("toolErase")?.classList.toggle("is-on", tool === "erase");
  const help = $("paintHelp");
  if (help) {
    help.textContent =
      tool === "erase"
        ? "当前：熄灭。在格子上点或拖关掉。"
        : tool === "recolor"
          ? "当前：改色。选新颜色后点色块，整块换成新色。"
          : "当前：点色。选颜色后点一次上色，再点同一格熄灭；拖动能连续画/擦。";
  }
  renderBeadUi();
}

$("toolPaint")?.addEventListener("click", () => setEditTool("paint"));
$("toolRecolor")?.addEventListener("click", () => setEditTool("recolor"));
$("toolErase")?.addEventListener("click", () => setEditTool("erase"));

$("btnExtinguishColor")?.addEventListener("click", () => {
  if (!state.paintCode) {
    setBeadStatus("请先点选一种颜色，再熄灭该色");
    return;
  }
  extinguishColor(state.paintCode);
});

$("btnUndoBead")?.addEventListener("click", () => undoBeadEdit());

$("btnBeadAll")?.addEventListener("click", () => {
  state.litCodes = new Set();
  renderBeadUi();
});

btnReset.addEventListener("click", () => {
  const f = state.fluid;
  state.fluid = new FlipFluid(PANEL_W, PANEL_H, state.fill);
  state.fluid.densityClamp = f.densityClamp;
  state.fluid.setGamma(f.gamma);
  state.fluid.gravityScale = f.gravityScale;
  state.fluid.pressureIters = f.pressureIters;
  state.fluid.flipRatio = f.flipRatio;
  state.lastFill = state.fill;
});

window.addEventListener("keydown", (e) => {
  const typing = /INPUT|TEXTAREA/.test(e.target && e.target.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
    if (!typing) {
      e.preventDefault();
      undoBeadEdit();
    }
    return;
  }
  if (typing) return;
  if (e.code === "Space") {
    e.preventDefault();
    setRotate(!state.rotateOn);
  } else if (e.code === "ArrowLeft") {
    state.angle -= 8;
    $("tilt").value = String(state.angle);
    $("v-tilt").textContent = `${Math.round(state.angle)}°`;
  } else if (e.code === "ArrowRight") {
    state.angle += 8;
    $("tilt").value = String(state.angle);
    $("v-tilt").textContent = `${Math.round(state.angle)}°`;
  } else if (e.key === "1" || e.key === "2" || e.key === "3") {
    document.querySelectorAll(".tabs button")[Number(e.key) - 1]?.click();
  }
});

function sampleColor(t) {
  const keys = [
    [0, 0, 0],
    [Math.max(10, state.cr >> 1), Math.max(10, state.cg >> 1), Math.max(10, state.cb >> 1)],
    [state.cr, state.cg, state.cb],
    [
      Math.min(255, (state.cr * 1.2) | 0),
      Math.min(255, (state.cg * 1.15) | 0),
      Math.min(255, (state.cb * 1.1) | 0),
    ],
    [
      Math.min(255, (state.cr * 1.4) | 0),
      Math.min(255, (state.cg * 1.3) | 0),
      Math.min(255, (state.cb * 1.2) | 0),
    ],
    [235, 250, 255],
  ];
  t = Math.pow(clamp01(t), 0.75);
  const p = t * (keys.length - 1);
  const i0 = Math.min(p | 0, keys.length - 1);
  const i1 = Math.min(i0 + 1, keys.length - 1);
  const ft = p - i0;
  return [
    keys[i0][0] + (keys[i1][0] - keys[i0][0]) * ft,
    keys[i0][1] + (keys[i1][1] - keys[i0][1]) * ft,
    keys[i0][2] + (keys[i1][2] - keys[i0][2]) * ft,
  ];
}

function clamp01(x) {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function applyBeadPattern(pattern, title, options = {}) {
  const { rows, palette } = pattern;
  state.beads = centerOnPanel(rows, PANEL_W, PANEL_H, palette || state.sourcePalette);
  state.litCodes = new Set();
  state.history = [];
  state.patternDirty = false;
  if ("id" in options) state.currentPatternId = options.id;
  if ("name" in options && $("patternName")) $("patternName").value = options.name;
  if (!state.paintCode || !MARD_BY_CODE.has(state.paintCode)) state.paintCode = "A5";
  refreshBeadDisplay();
  setBeadStatus(title || "空白 16×16。从 377 色里选颜色后点格子。");
  renderPatternList();
}

function refreshBeadDisplay() {
  const beads = state.beads;
  if (!beads) return;
  const next = {};
  for (const row of beads.rows) {
    for (const code of row) {
      if (code === ".") continue;
      next[code] = state.sourcePalette[code] || MARD_BY_CODE.get(code)?.rgb?.slice();
    }
  }
  beads.palette = next;
  if (state.litCodes.size) {
    for (const id of [...state.litCodes]) {
      if (!next[id]) state.litCodes.delete(id);
    }
  }
  renderBeadUi();
}

function extinguishColor(code) {
  const beads = state.beads;
  if (!beads || !code) return;
  let changed = false;
  pushBeadHistory();
  for (let y = 0; y < beads.h; y++) {
    for (let x = 0; x < beads.w; x++) {
      if (beads.rows[y][x] === code) {
        beads.rows[y][x] = ".";
        changed = true;
      }
    }
  }
  if (!changed) {
    state.history.pop();
    return;
  }
  markPatternDirty();
  refreshBeadDisplay();
  setBeadStatus(`已熄灭 ${code}，色号列表已更新。可继续点色或按颜色数合并。`);
}

function replaceAllColors(fromCode, toCode) {
  const beads = state.beads;
  if (!beads || !fromCode || !toCode || fromCode === toCode) return;
  const rgb = paintRgb(toCode);
  if (!rgb) {
    setBeadStatus("请从 377 色板里选择要换成的颜色");
    return;
  }
  let changed = false;
  pushBeadHistory();
  beads.rows = beads.rows.map((row) =>
    row.map((code) => {
      if (code !== fromCode) return code;
      changed = true;
      return toCode;
    })
  );
  if (!changed) {
    state.history.pop();
    setBeadStatus(`${fromCode} 没有格子可替换。`);
    return;
  }
  beads.palette[toCode] = rgb.slice();
  markPatternDirty();
  refreshBeadDisplay();
  setBeadStatus(`已把 ${fromCode} 全部换成 ${toCode}。`);
}

function cloneRows(rows) {
  return rows.map((row) => row.slice());
}

function pushBeadHistory() {
  if (!state.beads) return;
  state.history.push(cloneRows(state.beads.rows));
  if (state.history.length > 40) state.history.shift();
}

function undoBeadEdit() {
  const prev = state.history.pop();
  if (!prev || !state.beads) return;
  state.beads.rows = prev;
  markPatternDirty();
  refreshBeadDisplay();
}

function resolvePaintTarget(localX, localY, strokeMode) {
  if (state.editTool === "erase") return ".";
  if (state.editTool === "recolor") return state.paintCode || null;
  // 点色：点一次上色，再点同一格（已是当前色）熄灭
  if (strokeMode === "erase") return ".";
  if (strokeMode === "paint") return state.paintCode || null;
  const code = state.beads?.rows?.[localY]?.[localX];
  if (state.paintCode && code === state.paintCode) return ".";
  return state.paintCode || null;
}

function paintBeadCell(localX, localY, flood, skipHistory = false, strokeMode = null) {
  if (!state.beads) {
    state.beads = centerOnPanel([], PANEL_W, PANEL_H, state.sourcePalette || {});
  }
  const board = state.beads;
  if (localX < 0 || localY < 0 || localX >= board.w || localY >= board.h) return;
  const target = resolvePaintTarget(localX, localY, strokeMode);
  if (target == null) {
    setBeadStatus("请先选颜色，再点 16×16 点色板");
    return;
  }
  if (board.rows[localY][localX] === target) return;
  if (target !== ".") {
    const rgb = MARD_BY_CODE.get(target)?.rgb || state.sourcePalette[target];
    if (!rgb) {
      setBeadStatus("请从 377 色板里选择颜色");
      return;
    }
    board.palette[target] = rgb.slice();
  }
  if (!skipHistory) pushBeadHistory();
  const source = board.rows[localY][localX];
  const useFlood = flood || (state.editTool === "recolor" && source !== ".");
  if (useFlood) board.rows = floodFill(board.rows, localX, localY, target);
  else board.rows[localY][localX] = target;
  markPatternDirty();
  refreshBeadDisplay();
}

function beadCellFromEvent(event, surface) {
  const el = surface || canvas;
  const rect = el.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const cell = el.width / PANEL_W;
  const px = ((event.clientX - rect.left) / rect.width) * el.width;
  const py = ((event.clientY - rect.top) / rect.height) * el.height;
  const x = Math.floor(px / cell);
  const y = Math.floor(py / cell);
  if (x < 0 || y < 0 || x >= PANEL_W || y >= PANEL_H) return null;
  return { x, y };
}

function bindPaintSurface(el) {
  if (!el) return;
  let painting = false;
  let lastKey = "";
  let strokeMode = null;
  el.addEventListener("pointerdown", (event) => {
    if (event.button === 2) return;
    const cell = beadCellFromEvent(event, el);
    if (!cell) return;
    event.preventDefault();
    try {
      el.setPointerCapture?.(event.pointerId);
    } catch {
      /* ignore */
    }
    painting = state.editTool !== "recolor";
    lastKey = `${cell.x},${cell.y}`;
    if (state.editTool === "paint") {
      const cur = state.beads?.rows?.[cell.y]?.[cell.x];
      strokeMode = state.paintCode && cur === state.paintCode ? "erase" : "paint";
    } else if (state.editTool === "erase") {
      strokeMode = "erase";
    } else {
      strokeMode = null;
    }
    pushBeadHistory();
    paintBeadCell(cell.x, cell.y, state.editTool === "recolor" || event.shiftKey, true, strokeMode);
  });
  el.addEventListener("pointermove", (event) => {
    if (!painting || event.buttons === 0) return;
    const cell = beadCellFromEvent(event, el);
    if (!cell) return;
    const key = `${cell.x},${cell.y}`;
    if (key === lastKey) return;
    lastKey = key;
    paintBeadCell(cell.x, cell.y, false, true, strokeMode);
  });
  el.addEventListener("pointerup", () => {
    painting = false;
    lastKey = "";
    strokeMode = null;
  });
  el.addEventListener("pointercancel", () => {
    painting = false;
    strokeMode = null;
    lastKey = "";
  });
  el.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const cell = beadCellFromEvent(event, el);
    if (!cell) return;
    const prev = state.editTool;
    state.editTool = "erase";
    pushBeadHistory();
    paintBeadCell(cell.x, cell.y, event.shiftKey, true);
    state.editTool = prev;
  });
}

const beadBoard = $("beadBoard");
bindPaintSurface(beadBoard);
bindPaintSurface(canvas);

function drawBeadBoard() {
  if (!beadBoard) return;
  const bctx = beadBoard.getContext("2d");
  const cell = beadBoard.width / PANEL_W;
  bctx.fillStyle = "#14282c";
  bctx.fillRect(0, 0, beadBoard.width, beadBoard.height);
  const beads = state.beads;
  for (let y = 0; y < PANEL_H; y++) {
    for (let x = 0; x < PANEL_W; x++) {
      const code = beads?.rows?.[y]?.[x];
      const rgb = code && code !== "." ? beads.palette[code] : null;
      if (rgb && isCodeLit(code)) bctx.fillStyle = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
      else bctx.fillStyle = "#1c3338";
      bctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
    }
  }
}

function isCodeLit(code) {
  if (!code || code === ".") return false;
  const rgb = state.beads?.palette?.[code] || state.sourcePalette[code];
  if (!rgb) return false;
  if (!state.litCodes.size) return true;
  return state.litCodes.has(code);
}

function beadCss(rx, ry) {
  const beads = state.beads;
  if (!beads) return null;
  const x = rx - beads.ox;
  const y = ry - beads.oy;
  if (x < 0 || y < 0 || x >= beads.w || y >= beads.h) return null;
  const code = beads.rows[y][x];
  if (!isCodeLit(code)) return null;
  const rgb = beads.palette[code] || state.sourcePalette[code];
  if (!rgb) return null;
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

function toggleLit(code) {
  const next = new Set(state.litCodes);
  if (next.has(code)) next.delete(code);
  else next.add(code);
  state.litCodes = next;
  renderBeadUi();
}

function setBeadStatus(text) {
  const el = $("beadStatus");
  if (el && text != null) el.textContent = text;
  renderBeadUi();
}

function renderBeadUi() {
  const beads = state.beads;
  const head = $("beadLegendHead");
  const legend = $("beadLegend");
  const layers = $("beadLayers");
  const map = $("beadMap");
  const overlay = $("beadOverlay");
  const overlayWrap = $("beadOverlayWrap");
  const wrap = $("beadCombinedWrap");
  const btnAll = $("btnBeadAll");
  if (!legend || !layers || !map) return;

  legend.replaceChildren();
  layers.replaceChildren();
  map.textContent = "";
  if (overlay) overlay.textContent = "";
  if (head) head.classList.toggle("is-on", Boolean(beads));
  if (btnAll) btnAll.hidden = !state.litCodes.size;
  if (wrap) wrap.hidden = !beads;
  if (overlayWrap) overlayWrap.hidden = true;

  if (!beads) return;

  const used = beads.palette;
  const tray = Object.keys(used).length ? used : {};
  const isolating = state.litCodes.size > 0;
  for (const [code, rgb] of Object.entries(tray)) {
    if (!rgb) continue;
    const count = countCode(beads.rows, code);
    if (Object.keys(used).length && count <= 0 && code !== state.paintCode) continue;
    const on = state.litCodes.has(code);
    const item = document.createElement("button");
    item.type = "button";
    item.className = `bead-swatch${on ? " is-on" : ""}${state.paintCode === code ? " is-paint" : ""}`;
    item.title = state.paintCode === "" ? "熄灭笔已开启：点此熄灭该色全部格子" : "点此选画笔，再到 16×16 灯板上点色";
    const chip = document.createElement("i");
    chip.style.background = `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
    item.append(chip, document.createTextNode(`${code} ×${count}`));
    item.addEventListener("click", () => {
      if (state.editTool === "erase") {
        extinguishColor(code);
        return;
      }
      selectPaintColor(code);
    });
    item.addEventListener("dblclick", (event) => {
      event.preventDefault();
      toggleLit(code);
    });
    legend.append(item);

    const layer = document.createElement("div");
    layer.className = `bead-layer${on ? " is-on" : isolating ? " is-dim" : ""}`;
    const title = document.createElement("div");
    title.className = "bead-layer-title";
    title.textContent = `${code} 字母表`;
    const pre = document.createElement("pre");
    pre.className = "bead-map";
    pre.textContent = letterTable(beads.rows, new Set([code]));
    layer.append(title, pre);
    title.addEventListener("click", () => toggleLit(code));
    layers.append(layer);
  }

  map.textContent = letterTable(beads.rows);
  if (isolating && overlay && overlayWrap) {
    overlayWrap.hidden = false;
    overlay.textContent = letterTable(beads.rows, state.litCodes);
  }
  const paintLabel = $("paintLabel");
  if (paintLabel) {
    paintLabel.textContent = state.editTool === "erase" ? "熄灭" : state.paintCode || "未选";
  }
  syncPaintSwatch();
  const replaceFrom = $("replaceFrom");
  if (replaceFrom) {
    const usedCodes = Object.keys(used).filter((code) => countCode(beads.rows, code) > 0);
    const keep = state.replaceFrom && usedCodes.includes(state.replaceFrom) ? state.replaceFrom : usedCodes[0] || "";
    state.replaceFrom = keep;
    replaceFrom.replaceChildren();
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = usedCodes.length ? "选择已用色" : "还没有已用色";
    replaceFrom.append(blank);
    for (const code of usedCodes) {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = `${code} ×${countCode(beads.rows, code)}`;
      replaceFrom.append(option);
    }
    replaceFrom.value = keep;
  }
  drawBeadBoard();
}

loadStoredPatterns();
applyBeadPattern({ rows: [], palette: state.sourcePalette }, "空白 16×16。从下方 377 色选颜色，再点格子。");
restoreLastPattern();
renderPatternList();
setEditTool("paint");
renderColorPicker();

function draw(grid) {
  const w = state.fluid.visibleW;
  const h = state.fluid.visibleH;
  const px = w * LED_CELL;
  const py = h * LED_CELL;
  if (canvas.width !== px || canvas.height !== py) {
    canvas.width = px;
    canvas.height = py;
  }

  ctx.fillStyle = "#14282c";
  ctx.fillRect(0, 0, px, py);

  const gain = state.previewGain;
  const maxV = state.fluid.ledValMax;
  const rLed = LED_CELL * 0.38;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.min(Math.max(grid[x * h + y], 0), maxV);
      const t = (v * gain) / (maxV * gain);
      let [cr, cg, cb] = sampleColor(t);
      if (v > 0.05 && state.blue > 0) {
        cb = Math.min(255, (cb * state.blue) / 180);
      }
      const rx = w - 1 - x;
      const ry = h - 1 - y;
      const cx = rx * LED_CELL + LED_CELL / 2;
      const cy = ry * LED_CELL + LED_CELL / 2;
      ctx.beginPath();
      ctx.arc(cx, cy, rLed, 0, Math.PI * 2);
      const bead = beadCss(rx, ry);
      if (bead) {
        ctx.fillStyle = bead;
      } else if (v < 0.05) {
        ctx.fillStyle = "rgb(38, 54, 58)";
      } else {
        ctx.fillStyle = `rgb(${cr | 0}, ${cg | 0}, ${cb | 0})`;
      }
      ctx.fill();
    }
  }
}

let last = performance.now();
let acc = 0;

function frame(now) {
  const targetDt = 1 / Math.max(state.fps, 1);
  const frameDt = Math.min((now - last) / 1000, 0.05);
  last = now;
  acc += frameDt;

  if (state.rotateOn) {
    state.angle += state.rotateSpeed * frameDt;
    const wrapped = ((((state.angle + 180) % 360) + 360) % 360) - 180;
    state.angle = wrapped;
    $("tilt").value = String(state.angle);
    $("v-tilt").textContent = `${Math.round(state.angle)}°`;
  } else {
    state.angle = Number($("tilt").value);
  }

  if (Math.abs(state.fill - state.lastFill) > 0.01) {
    state.fluid.setFillRatio(state.fill);
    state.lastFill = state.fill;
  }

  // fixed sim step matched to fps setting
  while (acc >= targetDt) {
    const rad = (waterAngleFromTilt(state.angle) * Math.PI) / 180;
    const gx = Math.cos(rad);
    const gy = Math.sin(rad);
    state.fluid.step(targetDt, gx, gy);
    acc -= targetDt;
  }

  const grid = state.fluid.getLedGrid();
  draw(grid);

  const vis = visualBottleDeg(state.angle);
  const waterDeg = waterAngleFromTilt(state.angle);
  // CSS variable avoids fighting animation/other transform rules
  bottle.style.setProperty("--bottle-rot", `${vis}deg`);
  needle.style.transform = `translate(-50%, -100%) rotate(${vis}deg)`;
  angleLabel.textContent = `倾斜 ${Math.round(state.angle)}° · 水 ${Math.round(waterDeg)}°`;
  particleLabel.textContent = `${state.fluid.numParticles} 粒子`;
  if (gridLabel) gridLabel.textContent = `${state.fluid.visibleW}×${state.fluid.visibleH}`;

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
