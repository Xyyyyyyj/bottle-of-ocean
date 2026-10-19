/**
 * FLIP fluid — ported from firmware flip.cpp / desktop_ocean.py
 * Grid: visible W×H with 1-cell padding walls.
 */
export const PANEL_W = 16;
export const PANEL_H = 16;

const AIR = 0;
const FLUID = 1;
const SOLID = 2;

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

export class FlipFluid {
  constructor(visibleW = PANEL_W, visibleH = PANEL_H, fillRatio = 0.6) {
    this.visibleW = visibleW;
    this.visibleH = visibleH;
    this.fNumX = visibleW + 2;
    this.fNumY = visibleH + 2;

    const simW = 1.0;
    const simH = simW * ((visibleH + 1) / (visibleW + 1));
    const hx = simW / (this.fNumX - 1);
    const hy = simH / (this.fNumY - 1);
    this.h = Math.min(hx, hy);
    const tankW = this.h * (this.fNumX - 1);
    const tankH = this.h * (this.fNumY - 1);
    this.invH = 1 / this.h;
    this.nCells = this.fNumX * this.fNumY;

    this.density = 1000;
    this.gravityScale = 9.81;
    this.pushIters = 1;
    this.pressureIters = 10;
    this.flipRatio = 0.9;
    this.gamma = 0.6;
    this.densityClamp = 1.2;
    this.ledValMax = 20;

    const r = 0.35 * this.h;
    this.particleRadius = r;
    this.pInv = 1 / (2.2 * r);
    this.pNumX = Math.floor(tankW * this.pInv) + 1;
    this.pNumY = Math.floor(tankH * this.pInv) + 1;
    this.pCells = this.pNumX * this.pNumY;

    const dx = 2 * r;
    const dy = (Math.sqrt(3) / 2) * dx;
    const numX = Math.max(Math.floor((0.8 * tankW - 2 * this.h - 2 * r) / dx), 1);
    const numY = Math.max(Math.floor((fillRatio * tankH - 2 * this.h - 2 * r) / dy), 1);
    this.baseParticles = numX * numY;
    this.maxParticles = Math.max(this.baseParticles + 256, this.baseParticles * 2);

    const n = this.nCells;
    this.u = new Float32Array(n);
    this.v = new Float32Array(n);
    this.du = new Float32Array(n);
    this.dv = new Float32Array(n);
    this.prevU = new Float32Array(n);
    this.prevV = new Float32Array(n);
    this.p = new Float32Array(n);
    this.s = new Float32Array(n);
    this.cellType = new Int32Array(n);
    this.particleDensity = new Float32Array(n);
    this.restDensity = 0;

    this.pos = new Float32Array(this.maxParticles * 2);
    this.vel = new Float32Array(this.maxParticles * 2);
    this.numParticles = 0;

    this.numCellParticles = new Int32Array(this.pCells);
    this.firstCellParticle = new Int32Array(this.pCells + 1);
    this.cellParticleIds = new Int32Array(this.maxParticles);

    const ny = this.fNumY;
    for (let i = 0; i < this.fNumX; i++) {
      for (let j = 0; j < this.fNumY; j++) {
        this.s[i * ny + j] =
          i === 0 || i === this.fNumX - 1 || j === 0 || j === this.fNumY - 1 ? 0 : 1;
      }
    }

    this._spawnHex(fillRatio);
    this.baseParticles = this.numParticles;
    this._rebuildGamma();
  }

  _rebuildGamma() {
    this.gammaLut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      this.gammaLut[i] = Math.round(Math.pow(i / 255, this.gamma) * 255);
    }
  }

  setGamma(g) {
    this.gamma = g;
    this._rebuildGamma();
  }

  _spawnHex(fillRatio) {
    const h = this.h;
    const r = this.particleRadius;
    const dx = 2 * r;
    const dy = (Math.sqrt(3) / 2) * dx;
    const tankW = h * (this.fNumX - 1);
    const tankH = h * (this.fNumY - 1);
    const numX = Math.max(Math.floor((0.8 * tankW - 2 * h - 2 * r) / dx), 1);
    const numY = Math.max(Math.floor((fillRatio * tankH - 2 * h - 2 * r) / dy), 1);
    let idx = 0;
    for (let i = 0; i < numX && idx < this.maxParticles; i++) {
      for (let j = 0; j < numY && idx < this.maxParticles; j++) {
        this.pos[idx * 2] = h + r + dx * i + (j % 2 === 0 ? 0 : r);
        this.pos[idx * 2 + 1] = h + r + dy * j;
        this.vel[idx * 2] = 0;
        this.vel[idx * 2 + 1] = 0;
        idx++;
      }
    }
    this.numParticles = idx;
    this.restDensity = 0;
  }

  setFillRatio(fill) {
    fill = clamp(fill, 0.15, 1.6);
    let desired = Math.round(this.baseParticles * fill);
    desired = clamp(desired, 1, this.maxParticles);
    const n = this.numParticles;
    if (desired <= n) {
      this.numParticles = desired;
      return;
    }
    const h = this.h;
    const r = this.particleRadius;
    const minX = h + r;
    const maxX = (this.fNumX - 1) * h - r;
    const minY = h + r;
    const maxY = (this.fNumY - 1) * h - r;
    for (let i = n; i < desired; i++) {
      this.pos[i * 2] = minX + Math.random() * (maxX - minX);
      this.pos[i * 2 + 1] = minY + Math.random() * (maxY - minY);
      this.vel[i * 2] = 0;
      this.vel[i * 2 + 1] = 0;
    }
    this.numParticles = desired;
  }

  step(dt, gx, gy) {
    const n = this.numParticles;
    if (n <= 0) return;
    const Gx = gx * this.gravityScale;
    const Gy = gy * this.gravityScale;
    this._integrate(dt, Gx, Gy);
    this._pushApart();
    this._collide();
    this._transfer(true);
    this._updateDensity();
    if (this.restDensity <= 0) this._calcRest();
    this._solvePressure(dt);
    this._transfer(false);
  }

  _integrate(dt, gx, gy) {
    const n = this.numParticles;
    for (let i = 0; i < n; i++) {
      this.vel[i * 2] += gx * dt;
      this.vel[i * 2 + 1] += gy * dt;
      this.pos[i * 2] += this.vel[i * 2] * dt;
      this.pos[i * 2 + 1] += this.vel[i * 2 + 1] * dt;
    }
  }

  _pushApart() {
    const n = this.numParticles;
    const minDist = 2 * this.particleRadius;
    const minDist2 = minDist * minDist;
    const inv = this.pInv;
    const px = this.pNumX;
    const py = this.pNumY;

    this.numCellParticles.fill(0);
    for (let i = 0; i < n; i++) {
      const xi = clamp((this.pos[i * 2] * inv) | 0, 0, px - 1);
      const yi = clamp((this.pos[i * 2 + 1] * inv) | 0, 0, py - 1);
      this.numCellParticles[xi * py + yi]++;
    }

    let first = 0;
    for (let c = 0; c < this.pCells; c++) {
      first += this.numCellParticles[c];
      this.firstCellParticle[c] = first;
    }
    this.firstCellParticle[this.pCells] = first;

    for (let i = 0; i < n; i++) {
      const xi = clamp((this.pos[i * 2] * inv) | 0, 0, px - 1);
      const yi = clamp((this.pos[i * 2 + 1] * inv) | 0, 0, py - 1);
      const cell = xi * py + yi;
      this.firstCellParticle[cell]--;
      this.cellParticleIds[this.firstCellParticle[cell]] = i;
    }

    for (let it = 0; it < this.pushIters; it++) {
      for (let i = 0; i < n; i++) {
        const pxi = this.pos[i * 2];
        const pyi = this.pos[i * 2 + 1];
        const ix = (pxi * inv) | 0;
        const iy = (pyi * inv) | 0;
        const x0 = Math.max(ix - 1, 0);
        const y0 = Math.max(iy - 1, 0);
        const x1 = Math.min(ix + 1, px - 1);
        const y1 = Math.min(iy + 1, py - 1);
        for (let xi = x0; xi <= x1; xi++) {
          for (let yi = y0; yi <= y1; yi++) {
            const cell = xi * py + yi;
            const a = this.firstCellParticle[cell];
            const b = this.firstCellParticle[cell + 1];
            for (let k = a; k < b; k++) {
              const j = this.cellParticleIds[k];
              if (j === i) continue;
              let dx = this.pos[j * 2] - pxi;
              let dy = this.pos[j * 2 + 1] - pyi;
              const d2 = dx * dx + dy * dy;
              if (d2 > minDist2 || d2 === 0) continue;
              const d = Math.sqrt(d2);
              const s = (0.5 * (minDist - d)) / d;
              dx *= s;
              dy *= s;
              this.pos[i * 2] -= dx;
              this.pos[i * 2 + 1] -= dy;
              this.pos[j * 2] += dx;
              this.pos[j * 2 + 1] += dy;
            }
          }
        }
      }
    }
  }

  _collide() {
    const n = this.numParticles;
    const h = this.h;
    const r = this.particleRadius;
    const minX = h + r;
    const maxX = (this.fNumX - 1) * h - r;
    const minY = h + r;
    const maxY = (this.fNumY - 1) * h - r;
    for (let i = 0; i < n; i++) {
      let x = this.pos[i * 2];
      let y = this.pos[i * 2 + 1];
      if (x < minX) {
        this.pos[i * 2] = minX;
        this.vel[i * 2] = 0;
      } else if (x > maxX) {
        this.pos[i * 2] = maxX;
        this.vel[i * 2] = 0;
      }
      if (y < minY) {
        this.pos[i * 2 + 1] = minY;
        this.vel[i * 2 + 1] = 0;
      } else if (y > maxY) {
        this.pos[i * 2 + 1] = maxY;
        this.vel[i * 2 + 1] = 0;
      }
    }
  }

  _updateDensity() {
    const n = this.numParticles;
    const ny = this.fNumY;
    const h = this.h;
    const h2 = 0.5 * h;
    const inv = this.invH;
    this.particleDensity.fill(0);
    for (let i = 0; i < n; i++) {
      let x = clamp(this.pos[i * 2], h, (this.fNumX - 1) * h);
      let y = clamp(this.pos[i * 2 + 1], h, (this.fNumY - 1) * h);
      let x0 = ((x - h2) * inv) | 0;
      const tx = (x - h2 - x0 * h) * inv;
      const x1 = Math.min(x0 + 1, this.fNumX - 2);
      let y0 = ((y - h2) * inv) | 0;
      const ty = (y - h2 - y0 * h) * inv;
      const y1 = Math.min(y0 + 1, this.fNumY - 2);
      const sx = 1 - tx;
      const sy = 1 - ty;
      this.particleDensity[x0 * ny + y0] += sx * sy;
      this.particleDensity[x1 * ny + y0] += tx * sy;
      this.particleDensity[x1 * ny + y1] += tx * ty;
      this.particleDensity[x0 * ny + y1] += sx * ty;
    }
  }

  _calcRest() {
    let sum = 0;
    let cnt = 0;
    for (let i = 0; i < this.nCells; i++) {
      sum += this.particleDensity[i];
      if (this.cellType[i] === FLUID) cnt++;
    }
    this.restDensity = cnt > 0 ? sum / cnt : 0;
  }

  _transfer(toGrid) {
    const n = this.numParticles;
    const ny = this.fNumY;
    const h = this.h;
    const h2 = 0.5 * h;
    const inv = this.invH;
    const flipRatio = this.flipRatio;

    if (toGrid) {
      this.prevU.set(this.u);
      this.prevV.set(this.v);
      this.du.fill(0);
      this.dv.fill(0);
      this.u.fill(0);
      this.v.fill(0);
      for (let i = 0; i < this.nCells; i++) {
        this.cellType[i] = this.s[i] === 0 ? SOLID : AIR;
      }
      for (let i = 0; i < n; i++) {
        const xi = clamp((this.pos[i * 2] * inv) | 0, 0, this.fNumX - 1);
        const yi = clamp((this.pos[i * 2 + 1] * inv) | 0, 0, this.fNumY - 1);
        const cell = xi * ny + yi;
        if (this.cellType[cell] === AIR) this.cellType[cell] = FLUID;
      }
    }

    for (let component = 0; component < 2; component++) {
      const dx = component === 0 ? 0 : h2;
      const dy = component === 0 ? h2 : 0;
      const f = component === 0 ? this.u : this.v;
      const prevF = component === 0 ? this.prevU : this.prevV;
      const d = component === 0 ? this.du : this.dv;

      for (let i = 0; i < n; i++) {
        let x = clamp(this.pos[i * 2], h, (this.fNumX - 1) * h);
        let y = clamp(this.pos[i * 2 + 1], h, (this.fNumY - 1) * h);
        let x0 = Math.min(((x - dx) * inv) | 0, this.fNumX - 2);
        const tx = (x - dx - x0 * h) * inv;
        const x1 = Math.min(x0 + 1, this.fNumX - 2);
        let y0 = Math.min(((y - dy) * inv) | 0, this.fNumY - 2);
        const ty = (y - dy - y0 * h) * inv;
        const y1 = Math.min(y0 + 1, this.fNumY - 2);
        const sx = 1 - tx;
        const sy = 1 - ty;
        const w0 = sx * sy;
        const w1 = tx * sy;
        const w2 = tx * ty;
        const w3 = sx * ty;
        const nr0 = x0 * ny + y0;
        const nr1 = x1 * ny + y0;
        const nr2 = x1 * ny + y1;
        const nr3 = x0 * ny + y1;

        if (toGrid) {
          const pv = this.vel[i * 2 + component];
          f[nr0] += pv * w0;
          d[nr0] += w0;
          f[nr1] += pv * w1;
          d[nr1] += w1;
          f[nr2] += pv * w2;
          d[nr2] += w2;
          f[nr3] += pv * w3;
          d[nr3] += w3;
        } else {
          const offset = component === 0 ? ny : 1;
          const valid = (nr) =>
            this.cellType[nr] !== AIR || this.cellType[nr - offset] !== AIR ? 1 : 0;
          const v0 = valid(nr0);
          const v1 = valid(nr1);
          const v2 = valid(nr2);
          const v3 = valid(nr3);
          const dSum = v0 * w0 + v1 * w1 + v2 * w2 + v3 * w3;
          if (dSum > 0) {
            const pic =
              (v0 * w0 * f[nr0] + v1 * w1 * f[nr1] + v2 * w2 * f[nr2] + v3 * w3 * f[nr3]) /
              dSum;
            const corr =
              (v0 * w0 * (f[nr0] - prevF[nr0]) +
                v1 * w1 * (f[nr1] - prevF[nr1]) +
                v2 * w2 * (f[nr2] - prevF[nr2]) +
                v3 * w3 * (f[nr3] - prevF[nr3])) /
              dSum;
            const flipV = this.vel[i * 2 + component] + corr;
            this.vel[i * 2 + component] = (1 - flipRatio) * pic + flipRatio * flipV;
          }
        }
      }

      if (toGrid) {
        for (let i = 0; i < this.nCells; i++) {
          if (d[i] > 0) f[i] /= d[i];
        }
        for (let i = 0; i < this.fNumX; i++) {
          for (let j = 0; j < this.fNumY; j++) {
            const idx = i * ny + j;
            const solid = this.cellType[idx] === SOLID;
            if (solid || (i > 0 && this.cellType[(i - 1) * ny + j] === SOLID)) {
              this.u[idx] = this.prevU[idx];
            }
            if (solid || (j > 0 && this.cellType[i * ny + (j - 1)] === SOLID)) {
              this.v[idx] = this.prevV[idx];
            }
          }
        }
      }
    }
  }

  _solvePressure(dt) {
    const ny = this.fNumY;
    const over = 1.9;
    const cp = (this.density * this.h) / Math.max(dt, 1e-6);
    this.p.fill(0);
    this.prevU.set(this.u);
    this.prevV.set(this.v);
    const rest = this.restDensity;

    for (let it = 0; it < this.pressureIters; it++) {
      for (let i = 1; i < this.fNumX - 1; i++) {
        for (let j = 1; j < this.fNumY - 1; j++) {
          const center = i * ny + j;
          if (this.cellType[center] !== FLUID) continue;
          const left = (i - 1) * ny + j;
          const right = (i + 1) * ny + j;
          const bottom = i * ny + (j - 1);
          const top = i * ny + (j + 1);
          const sx0 = this.s[left];
          const sx1 = this.s[right];
          const sy0 = this.s[bottom];
          const sy1 = this.s[top];
          const sSum = sx0 + sx1 + sy0 + sy1;
          if (sSum === 0) continue;
          let div = this.u[right] - this.u[center] + (this.v[top] - this.v[center]);
          if (rest > 0) {
            const compression = this.particleDensity[center] - rest;
            if (compression > 0) div -= compression;
          }
          const pVal = (-div / sSum) * over;
          this.p[center] += cp * pVal;
          this.u[center] -= sx0 * pVal;
          this.u[right] += sx1 * pVal;
          this.v[center] -= sy0 * pVal;
          this.v[top] += sy1 * pVal;
        }
      }
    }
  }

  /** @returns {Float32Array} length W*H, brightness 0..ledValMax, layout x*H+y */
  getLedGrid() {
    const out = new Float32Array(this.visibleW * this.visibleH);
    const ny = this.fNumY;
    const rest = this.restDensity;
    for (let i = 0; i < this.visibleW; i++) {
      for (let j = 0; j < this.visibleH; j++) {
        let d = this.particleDensity[(i + 1) * ny + (j + 1)];
        if (rest > 0) d /= rest;
        let b = clamp(d / this.densityClamp, 0, 1);
        const bi = Math.round(b * 255);
        const bg = this.gammaLut[bi];
        out[i * this.visibleH + j] = bg * (this.ledValMax / 255);
      }
    }
    return out;
  }
}
