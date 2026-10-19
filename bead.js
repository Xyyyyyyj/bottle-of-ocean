/**
 * 导入图纸 → 定网格 → 逐格 OCR 色号 → 合法校验 → 二维矩阵。
 *
 * 1. 自动检测行列，或用手动行列均分图片。
 * 2. 每个有底色的格子按 Pindo 方式匹配 MARD 色板。
 * 3. 后期合并：孤立噪点清理 + 3×3 多数滤波（与 Pindo 相同）。
 * 4. 灯色用色板 RGB；H1/H2 写入但不亮。
 * 5. 图纸可大于 16×16；裁掉空边后字母表不超过灯板才上屏。
 */

import { isUnlitCode, validateColorCode } from "./mard-codes.js";
import { MARD_PALETTE, MARD_BY_CODE } from "./mard-palette.js";

export function letterTable(rows, codes) {
  const keep = codes && codes.size ? codes : null;
  const width = rows.reduce((w, row) => Math.max(w, ...row.map((c) => String(c).length)), 1);
  return rows
    .map((row) =>
      row
        .map((c) => {
          const shown = !keep || keep.has(c) ? c : ".";
          return String(shown).padEnd(width, " ");
        })
        .join(" "),
    )
    .join("\n");
}

export function countCode(rows, code) {
  let n = 0;
  for (const row of rows) for (const cell of row) if (cell === code) n++;
  return n;
}

/** 裁掉四周全是 "." 的空边，得到实际字母表。 */
export function trimToContent(rows) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < rows.length; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length; x++) {
      if (row[x] === ".") continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < 0) return { rows: [], w: 0, h: 0, x0: 0, y0: 0 };
  const next = [];
  for (let y = minY; y <= maxY; y++) next.push(rows[y].slice(minX, maxX + 1));
  return { rows: next, w: maxX - minX + 1, h: maxY - minY + 1, x0: minX, y0: minY };
}

export function paletteForRows(rows, palette) {
  const used = new Set();
  for (const row of rows) for (const cell of row) if (cell !== ".") used.add(cell);
  const next = {};
  for (const code of used) {
    next[code] = (palette && palette[code]) || MARD_BY_CODE.get(code)?.rgb?.slice();
  }
  return next;
}

function codeDelta(a, b) {
  const ca = MARD_BY_CODE.get(a);
  const cb = MARD_BY_CODE.get(b);
  if (!ca || !cb) return 999;
  return ciede2000(
    { L: ca.lab[0], a: ca.lab[1], b: ca.lab[2] },
    { L: cb.lab[0], a: cb.lab[1], b: cb.lab[2] },
  );
}

/**
 * 按用户指定的颜色数合并近色、丢掉离群色。
 * 近邻色号收进用量最大的代表色；离所有代表色都远的格子熄灭。
 */
export function limitToColorCount(rows, maxColors, mergeDe = 20) {
  const n = Math.max(1, Math.round(Number(maxColors) || 0));
  const counts = new Map();
  for (const row of rows) {
    for (const c of row) {
      if (c === "." || isUnlitCode(c)) continue;
      counts.set(c, (counts.get(c) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
  if (!ranked.length) return rows.map((row) => row.slice());

  const keepers = [];
  for (const code of ranked) {
    if (keepers.length >= n) break;
    if (keepers.some((k) => codeDelta(k, code) < mergeDe)) continue;
    keepers.push(code);
  }
  for (const code of ranked) {
    if (keepers.length >= n) break;
    if (!keepers.includes(code)) keepers.push(code);
  }

  const remap = new Map();
  for (const code of ranked) {
    let best = keepers[0];
    let bestD = Infinity;
    for (const k of keepers) {
      const d = code === k ? 0 : codeDelta(code, k);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    remap.set(code, bestD <= mergeDe * 1.25 ? best : ".");
  }

  return rows.map((row) =>
    row.map((c) => {
      if (c === "." || isUnlitCode(c)) return c;
      return remap.has(c) ? remap.get(c) : ".";
    }),
  );
}

export function floodFill(rows, x, y, nextCode) {
  const h = rows.length;
  const w = h ? rows[0].length : 0;
  if (x < 0 || y < 0 || x >= w || y >= h) return rows;
  const prev = rows[y][x];
  if (prev === nextCode) return rows;
  const out = rows.map((row) => row.slice());
  const stack = [[x, y]];
  while (stack.length) {
    const [cx, cy] = stack.pop();
    if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
    if (out[cy][cx] !== prev) continue;
    out[cy][cx] = nextCode;
    stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]);
  }
  return out;
}

function medianChannel(samples) {
  const sorted = samples.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return sorted[sorted.length >> 1];
}

function meanColor(samples) {
  let r = 0;
  let g = 0;
  let b = 0;
  for (const s of samples) {
    r += s[0];
    g += s[1];
    b += s[2];
  }
  const n = samples.length || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function srgbToLinear(c) {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(r, g, b) {
  const lr = srgbToLinear(r);
  const lg = srgbToLinear(g);
  const lb = srgbToLinear(b);
  const x = lr * 0.4124564 + lg * 0.3575761 + lb * 0.1804375;
  const y = lr * 0.2126729 + lg * 0.7151522 + lb * 0.072175;
  const z = lr * 0.0193339 + lg * 0.119192 + lb * 0.9503041;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / 0.95047);
  const fy = f(y);
  const fz = f(z / 1.08883);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

function ciede2000(lab1, lab2) {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cab = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cab ** 7 / (Cab ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const h1p = (Math.atan2(b1, a1p) * 180) / Math.PI + (b1 < 0 ? 360 : 0);
  const h2p = (Math.atan2(b2, a2p) * 180) / Math.PI + (b2 < 0 ? 360 : 0);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = h2p - h1p;
  if (Math.abs(dhp) > 180) dhp += dhp > 0 ? -360 : 360;
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360);
  const Lp = (L1 + L2) / 2;
  const Cp = (C1p + C2p) / 2;
  let hp = (h1p + h2p) / 2;
  if (Math.abs(h1p - h2p) > 180) hp -= 180;
  if (hp < 0) hp += 360;
  const T =
    1 -
    0.17 * Math.cos(((hp - 30) * Math.PI) / 180) +
    0.24 * Math.cos((2 * hp * Math.PI) / 180) +
    0.32 * Math.cos(((3 * hp + 6) * Math.PI) / 180) -
    0.2 * Math.cos(((4 * hp - 63) * Math.PI) / 180);
  const SL = 1 + (0.015 * (Lp - 50) ** 2) / Math.sqrt(20 + (Lp - 50) ** 2);
  const SC = 1 + 0.045 * Cp;
  const SH = 1 + 0.015 * Cp * T;
  const RT =
    -2 *
    Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7)) *
    Math.sin(60 * Math.exp(-(((hp - 275) / 25) ** 2)) * Math.PI / 180);
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

function matchMardColor(rgb) {
  const lab = rgbToLab(rgb[0], rgb[1], rgb[2]);
  let best = MARD_PALETTE[0];
  let bestDist = Infinity;
  for (const color of MARD_PALETTE) {
    const dist = ciede2000(lab, { L: color.lab[0], a: color.lab[1], b: color.lab[2] });
    if (dist < bestDist) {
      bestDist = dist;
      best = color;
    }
  }
  return best;
}

function paletteRgb(code, sample) {
  return MARD_BY_CODE.get(code)?.rgb?.slice() || sample;
}

function codeLuma(code) {
  const rgb = MARD_BY_CODE.get(code)?.rgb;
  if (!rgb) return undefined;
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function indexToCoord(index, width) {
  return [Math.floor(index / width), index % width];
}

function coordToIndex(row, col, width) {
  return row * width + col;
}

function neighbors4(row, col, width, height) {
  const result = [];
  if (row > 0) result.push([row - 1, col]);
  if (row + 1 < height) result.push([row + 1, col]);
  if (col > 0) result.push([row, col - 1]);
  if (col + 1 < width) result.push([row, col + 1]);
  return result;
}

/** 3×3 多数滤波：邻域里出现次数 ≥ minMajority 的色号替换当前格。 */
export function majorityFilter(rows, minMajority = 6) {
  const height = rows.length;
  const width = height ? rows[0].length : 0;
  const output = rows.map((row) => row.slice());
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const counts = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = y + dy;
          const nx = x + dx;
          if (ny < 0 || ny >= height || nx < 0 || nx >= width) continue;
          const id = rows[ny][nx];
          counts.set(id, (counts.get(id) ?? 0) + 1);
        }
      }
      let best = rows[y][x];
      let bestN = 0;
      for (const [id, n] of counts) {
        if (n > bestN) {
          best = id;
          bestN = n;
        }
      }
      if (bestN >= minMajority) output[y][x] = best;
    }
  }
  return output;
}

/** 把过小的连通块收进周围最多的邻色；高对比（如黑点在黄底上）保留。 */
export function removeIsolatedNoise(rows, minComponentSize = 2) {
  const height = rows.length;
  const width = height ? rows[0].length : 0;
  if (!width || minComponentSize < 1) return rows.map((row) => row.slice());
  const source = rows.map((row) => row.slice());
  const output = rows.map((row) => row.slice());
  const total = width * height;
  const visited = new Uint8Array(total);
  const contrastThreshold = 42;

  for (let start = 0; start < total; start++) {
    if (visited[start]) continue;
    const [startRow, startCol] = indexToCoord(start, width);
    const target = source[startRow][startCol];
    const queue = [start];
    const component = [];
    visited[start] = 1;
    while (queue.length) {
      const idx = queue.shift();
      component.push(idx);
      const [row, col] = indexToCoord(idx, width);
      for (const [nr, nc] of neighbors4(row, col, width, height)) {
        const nIdx = coordToIndex(nr, nc, width);
        if (visited[nIdx] || source[nr][nc] !== target) continue;
        visited[nIdx] = 1;
        queue.push(nIdx);
      }
    }
    if (component.length > minComponentSize) continue;

    const neighborCount = new Map();
    let maxContrast = 0;
    for (const idx of component) {
      const [row, col] = indexToCoord(idx, width);
      for (const [nr, nc] of neighbors4(row, col, width, height)) {
        const colorId = source[nr][nc];
        if (colorId === target) continue;
        neighborCount.set(colorId, (neighborCount.get(colorId) ?? 0) + 1);
        const a = codeLuma(target);
        const b = codeLuma(colorId);
        if (a !== undefined && b !== undefined) maxContrast = Math.max(maxContrast, Math.abs(a - b));
      }
    }
    if (!neighborCount.size) continue;
    if (maxContrast >= contrastThreshold) continue;

    let replace = target;
    let best = -1;
    for (const [colorId, count] of neighborCount) {
      if (count > best) {
        best = count;
        replace = colorId;
      }
    }
    for (const idx of component) {
      const [row, col] = indexToCoord(idx, width);
      output[row][col] = replace;
    }
  }
  return output;
}

export function cleanupPattern(rows) {
  return majorityFilter(removeIsolatedNoise(rows, 2), 6);
}

function isPaper(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return min >= 244 && max - min <= 10;
}

function isInk(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  return lum < 40 && chroma < 35;
}

function isBlank(r, g, b) {
  return isPaper(r, g, b);
}

function edgeProfile(data, width, height, axis) {
  const n = axis === "x" ? width : height;
  const other = axis === "x" ? height : width;
  const step = Math.max(1, Math.floor(other / 256));
  const profile = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = 0; j < other; j += step) {
      const i0 = axis === "x" ? (j * width + Math.max(0, i - 1)) * 4 : (Math.max(0, i - 1) * width + j) * 4;
      const i1 = axis === "x" ? (j * width + i) * 4 : (i * width + j) * 4;
      sum += abs3(data, i0, i1);
      count++;
    }
    profile[i] = sum / count;
  }
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    let k = 0;
    for (let d = -2; d <= 2; d++) {
      const t = i + d;
      if (t >= 0 && t < n) {
        acc += profile[t];
        k++;
      }
    }
    smooth[i] = acc / k;
  }
  return smooth;
}

function abs3(data, i0, i1) {
  return Math.abs(data[i1] - data[i0]) + Math.abs(data[i1 + 1] - data[i0 + 1]) + Math.abs(data[i1 + 2] - data[i0 + 2]);
}

function choosePitch(profile) {
  const n = profile.length;
  const minP = Math.max(12, Math.floor(n / 48));
  const maxP = Math.max(minP + 1, Math.floor(n / 2));
  const step = Math.max(1, Math.floor(n / 400));
  let best = 0;
  const scores = new Map();
  for (let p = minP; p < maxP; p++) {
    let s = 0;
    let count = 0;
    for (let i = 0; i + p < n; i += step) {
      s += profile[i] * profile[i + p];
      count++;
    }
    const score = s / Math.max(1, count);
    scores.set(p, score);
    if (score > best) best = score;
  }
  if (best <= 0) return null;
  let pitch = null;
  for (const [p, score] of scores) {
    if (score >= best * 0.92 && (pitch === null || p < pitch)) pitch = p;
  }
  return pitch;
}

function choosePhase(profile, pitch) {
  let bestO = 0;
  let bestS = -1;
  for (let o = 0; o < pitch; o++) {
    let s = 0;
    for (let k = 0; o + k * pitch < profile.length; k++) {
      s += profile[Math.min(profile.length - 1, o + k * pitch)];
    }
    if (s > bestS) {
      bestS = s;
      bestO = o;
    }
  }
  return bestO;
}

function spansFromProfile(profile, size) {
  const pitch = choosePitch(profile);
  if (!pitch) return [[0, size]];
  const phase = choosePhase(profile, pitch);
  const bounds = [];
  let t = phase;
  while (t - pitch > -pitch * 0.45) t -= pitch;
  if (t < 0) t = 0;
  while (t < size - pitch * 0.45) {
    bounds.push(t);
    t += pitch;
  }
  const last = bounds.length ? bounds[bounds.length - 1] : 0;
  bounds.push(size - last > pitch * 0.45 ? size : size);
  const clean = [];
  for (const raw of bounds) {
    const b = Math.max(0, Math.min(size, Math.round(raw)));
    if (!clean.length || b - clean[clean.length - 1] > pitch * 0.45) clean.push(b);
  }
  if (clean[clean.length - 1] !== size && size - clean[clean.length - 1] <= pitch * 0.45) {
    clean[clean.length - 1] = size;
  } else if (clean[clean.length - 1] !== size) {
    clean.push(size);
  }
  const spans = [];
  for (let i = 1; i < clean.length; i++) spans.push([clean[i - 1], clean[i]]);
  return spans;
}

function samplePixel(data, width, height, x, y) {
  const xi = Math.min(width - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(height - 1, Math.max(0, Math.round(y)));
  const i = (yi * width + xi) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

function cellHasLabel(data, width, height, x0, x1, y0, y1) {
  const xA = x0 + (x1 - x0) * 0.28;
  const xB = x0 + (x1 - x0) * 0.72;
  const yA = y0 + (y1 - y0) * 0.28;
  const yB = y0 + (y1 - y0) * 0.72;
  const stepX = Math.max(1, Math.floor((xB - xA) / 8));
  const stepY = Math.max(1, Math.floor((yB - yA) / 8));
  let ink = 0;
  let n = 0;
  for (let y = yA; y < yB; y += stepY) {
    for (let x = xA; x < xB; x += stepX) {
      const [r, g, b] = samplePixel(data, width, height, x, y);
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      n++;
      if (lum < 145) ink++;
    }
  }
  return n > 0 && ink / n > 0.06;
}

function sampleFill(data, width, height, x0, x1, y0, y1) {
  const samples = [];
  const spots = [
    [0.12, 0.12],
    [0.88, 0.12],
    [0.12, 0.88],
    [0.88, 0.88],
    [0.22, 0.12],
    [0.78, 0.12],
    [0.12, 0.22],
    [0.88, 0.22],
    [0.5, 0.1],
    [0.5, 0.9],
    [0.1, 0.5],
    [0.9, 0.5],
  ];
  for (const [fx, fy] of spots) {
    const [r, g, b] = samplePixel(data, width, height, x0 + (x1 - x0 - 1) * fx, y0 + (y1 - y0 - 1) * fy);
    if (!isBlank(r, g, b)) samples.push([r, g, b]);
  }
  if (samples.length < 2) return null;
  return medianChannel(samples);
}

/** Inner-cell dominant color, skipping paper/grid/ink like Pindo 主色采样。 */
function sampleCellRgb(data, width, height, x0, x1, y0, y1) {
  const cellW = Math.max(1, x1 - x0);
  const cellH = Math.max(1, y1 - y0);
  const left = x0 + cellW * 0.16;
  const right = x0 + cellW * 0.84;
  const top = y0 + cellH * 0.16;
  const bottom = y0 + cellH * 0.84;
  const cols = Math.max(5, Math.min(18, Math.round(cellW * 0.65)));
  const rows = Math.max(5, Math.min(18, Math.round(cellH * 0.65)));
  const bins = new Map();
  let best = null;
  let bestW = -1;
  let blank = 0;
  let n = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = left + ((col + 0.5) / cols) * (right - left);
      const y = top + ((row + 0.5) / rows) * (bottom - top);
      const [r, g, b] = samplePixel(data, width, height, x, y);
      n++;
      if (isPaper(r, g, b)) {
        blank++;
        continue;
      }
      if (isInk(r, g, b)) continue;
      const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
      let bin = bins.get(key);
      if (!bin) {
        bin = { w: 0, r: 0, g: 0, b: 0 };
        bins.set(key, bin);
      }
      bin.w += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      if (bin.w > bestW) {
        bestW = bin.w;
        best = bin;
      }
    }
  }
  if (blank / n > 0.88) return null;
  if (!best) {
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const x = left + ((col + 0.5) / cols) * (right - left);
        const y = top + ((row + 0.5) / rows) * (bottom - top);
        const [r, g, b] = samplePixel(data, width, height, x, y);
        if (isPaper(r, g, b)) continue;
        const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
        let bin = bins.get(key);
        if (!bin) {
          bin = { w: 0, r: 0, g: 0, b: 0 };
          bins.set(key, bin);
        }
        bin.w += 1;
        bin.r += r;
        bin.g += g;
        bin.b += b;
        if (bin.w > bestW) {
          bestW = bin.w;
          best = bin;
        }
      }
    }
  }
  if (!best) return null;
  return [Math.round(best.r / best.w), Math.round(best.g / best.w), Math.round(best.b / best.w)];
}

function gridSpans(data, width, height) {
  return {
    xs: spansFromProfile(edgeProfile(data, width, height, "x"), width),
    ys: spansFromProfile(edgeProfile(data, width, height, "y"), height),
  };
}

function spansForCount(size, count) {
  const n = Math.max(1, Math.round(count));
  const spans = [];
  for (let i = 0; i < n; i++) {
    spans.push([Math.round((size * i) / n), Math.round((size * (i + 1)) / n)]);
  }
  return spans;
}

export function detectGridSize(imageData) {
  const { data, width, height } = imageData;
  const { xs, ys } = gridSpans(data, width, height);
  return { cols: xs.length, rows: ys.length, xs, ys };
}

let ocrWorkerPromise = null;

async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = await import("https://cdn.jsdelivr.net/npm/tesseract.js@5/+esm");
      const worker = await createWorker("eng", 1);
      await worker.setParameters({
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
        tessedit_pageseg_mode: "7",
      });
      return worker;
    })();
  }
  return ocrWorkerPromise;
}

function labelCanvas(imageData, cell) {
  const { width } = imageData;
  const x0 = Math.round(cell.x0 + (cell.x1 - cell.x0) * 0.22);
  const x1 = Math.round(cell.x0 + (cell.x1 - cell.x0) * 0.78);
  const y0 = Math.round(cell.y0 + (cell.y1 - cell.y0) * 0.22);
  const y1 = Math.round(cell.y0 + (cell.y1 - cell.y0) * 0.78);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const scale = 4;
  const canvas = document.createElement("canvas");
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext("2d");
  const src = ctx.createImageData(w, h);
  const data = imageData.data;
  const fill = cell.rgb || [255, 255, 255];
  const fillLum = 0.299 * fill[0] + 0.587 * fill[1] + 0.114 * fill[2];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = ((y0 + y) * width + (x0 + x)) * 4;
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      const ink = lum < fillLum - 28 || lum < 130;
      const v = ink ? 0 : 255;
      const o = (y * w + x) * 4;
      src.data[o] = v;
      src.data[o + 1] = v;
      src.data[o + 2] = v;
      src.data[o + 3] = 255;
    }
  }
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  tmp.getContext("2d").putImageData(src, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(tmp, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function ocrCell(worker, imageData, cell) {
  const canvas = labelCanvas(imageData, cell);
  const result = await worker.recognize(canvas);
  return validateColorCode(result?.data?.text);
}

function resolveSpans(imageData, cols, rows) {
  const { data, width, height } = imageData;
  const detected = gridSpans(data, width, height);
  const xs = cols ? spansForCount(width, cols) : detected.xs.length >= 2 ? detected.xs : spansForCount(width, 16);
  const ys = rows ? spansForCount(height, rows) : detected.ys.length >= 2 ? detected.ys : spansForCount(height, 16);
  return { xs, ys, auto: { cols: detected.xs.length, rows: detected.ys.length } };
}

async function readGrid(imageData, xs, ys, onProgress) {
  const { data, width, height } = imageData;
  const cells = [];
  let matrix = [];
  const total = xs.length * ys.length;
  let done = 0;
  for (let y = 0; y < ys.length; y++) {
    const [y0, y1] = ys[y];
    const row = [];
    for (let x = 0; x < xs.length; x++) {
      const [x0, x1] = xs[x];
      const rgb = sampleCellRgb(data, width, height, x0, x1, y0, y1);
      const labeled = cellHasLabel(data, width, height, x0, x1, y0, y1);
      let code = ".";
      if (rgb) code = matchMardColor(rgb).code;
      const cell = { x, y, x0, x1, y0, y1, rgb, labeled, code };
      cells.push(cell);
      row.push(code);
      done++;
      if (onProgress) onProgress({ done, total, cols: xs.length, rows: ys.length, code, phase: "match" });
    }
    matrix.push(row);
  }

  matrix = cleanupPattern(matrix);
  for (const cell of cells) cell.code = matrix[cell.y][cell.x];

  const fills = {};
  for (const cell of cells) {
    const code = matrix[cell.y][cell.x];
    if (code === "." || isUnlitCode(code)) continue;
    if (!fills[code]) fills[code] = [];
    if (cell.rgb) fills[code].push(cell.rgb);
  }
  const palette = {};
  for (const [code, samples] of Object.entries(fills)) {
    palette[code] = paletteRgb(code, meanColor(samples));
  }
  return { rows: matrix, palette };
}

/**
 * @param {ImageData} imageData
 * @param {{ maxScan?: number, cols?: number, rows?: number, onProgress?: Function }} [options]
 */
export async function extractBeadPattern(imageData, options = {}) {
  const maxScan = options.maxScan ?? 80;
  const { xs, ys, auto } = resolveSpans(imageData, options.cols, options.rows);
  if (xs.length > maxScan || ys.length > maxScan) {
    throw new Error(`网格是 ${xs.length}×${ys.length}，请填写实际图纸行列后再识别`);
  }
  const { rows, palette } = await readGrid(imageData, xs, ys, options.onProgress);
  return { rows, palette, cols: xs.length, rowsCount: ys.length, auto };
}

export function centerOnPanel(rows, panelW, panelH, palette) {
  const bh = rows?.length || 0;
  const bw = bh ? rows[0].length : 0;
  if (bw > panelW || bh > panelH) {
    throw new Error(`图案是 ${bw}×${bh}，超过灯板 ${panelW}×${panelH}`);
  }
  const grid = Array.from({ length: panelH }, () => Array(panelW).fill("."));
  const ox = Math.floor((panelW - bw) / 2);
  const oy = Math.floor((panelH - bh) / 2);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) grid[oy + y][ox + x] = rows[y][x];
  }
  return {
    w: panelW,
    h: panelH,
    ox: 0,
    oy: 0,
    rows: grid,
    palette: palette || {},
  };
}
