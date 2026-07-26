/* ============================================================
   SOS · LOADNUG — Isometric 3D-looking city (Canvas 2D)
   Angled buildings · packets move on links with logos
   No top brand cards · big clear captions
   ============================================================ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, t) => {
  const x = clamp((t - a) / (b - a || 1e-6), 0, 1);
  return x * x * (3 - 2 * x);
};

const KINDS = [
  { name: 'P2P', col: '#22c55e' },
  { name: 'TORRENT', col: '#2ecc71' },
  { name: 'BLOSSOM', col: '#ff6b9d' },
  { name: 'RELAY', col: '#a78bfa' },
];

export class LoadNugFallback {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.opts = opts;
    this.ctx = canvas.getContext('2d', { alpha: false });
    if (!this.ctx) throw new Error('Canvas 2D unavailable');
    this.duration = opts.duration || 28;
    this.quality = opts.quality || 1;
    this._onProgress = opts.onProgress || (() => {});
    this._onPhase = opts.onPhase || (() => {});
    this._raf = 0;
    this._running = false;
    this._disposed = false;
    this._start = 0;
    this._holdSignaled = false;
    this._resolve = null;
    this._w = 0;
    this._h = 0;
    // isometric projection helpers
    this._tileW = 36;
    this._tileH = 18;
    this._resize();
    this._buildCity();
  }

  _viewport() {
    const vv = window.visualViewport;
    const w = Math.max(320, Math.round((vv && vv.width) || window.innerWidth || document.documentElement.clientWidth || 360));
    const h = Math.max(480, Math.round((vv && vv.height) || window.innerHeight || document.documentElement.clientHeight || 640));
    return { w, h };
  }

  _iso(ix, iy, iz) {
    // classic isometric: screen x/y from grid + height
    const x = (ix - iy) * (this._tileW * 0.5);
    const y = (ix + iy) * (this._tileH * 0.5) - iz;
    return { x, y };
  }

  _resize() {
    const mobile = !!this.opts.mobile || matchMedia('(max-width: 820px), (pointer: coarse)').matches;
    const dpr = Math.min(window.devicePixelRatio || 1, mobile ? 1.75 : 2);
    const { w, h } = this._viewport();
    const sizeChanged = !this._w || Math.abs(this._w - w) > 2 || Math.abs(this._h - h) > 2;
    this._w = w;
    this._h = h;
    this._tileW = clamp(w / 12, 28, 44);
    this._tileH = this._tileW * 0.5;
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (sizeChanged) this._buildCity();
  }

  _buildCity() {
    const cols = Math.round(clamp(10 * this.quality, 8, 12));
    const rows = Math.round(clamp(10 * this.quality, 8, 12));
    this._buildings = [];

    for (let iy = 0; iy < rows; iy++) {
      for (let ix = 0; ix < cols; ix++) {
        if ((ix + iy) % 5 === 0 && Math.random() < 0.4) continue; // streets / gaps
        const floors = 2 + ((Math.random() * 7) | 0);
        const h = floors * (this._tileH * 0.85);
        const col = Math.random() < 0.4 ? '#3d9eff' : (Math.random() < 0.5 ? '#7b6cff' : '#00d4b0');
        this._buildings.push({
          ix, iy, h, floors, col,
          delay: Math.random() * 1.6,
          lit: 0.4 + Math.random() * 0.6,
        });
      }
    }
    // paint far → near
    this._buildings.sort((a, b) => (a.ix + a.iy) - (b.ix + b.iy));

    // origin so city fills screen and sits toward bottom
    this._ox = this._w * 0.5;
    this._oy = this._h * 0.28;

    // nodes at rooftop centers for network
    this._nodes = this._buildings.map((b) => {
      const p = this._iso(b.ix, b.iy, b.h);
      return { x: this._ox + p.x, y: this._oy + p.y, b };
    });

    this._links = [];
    const maxLinks = Math.round(clamp(22 * this.quality, 14, 28));
    for (let i = 0; i < this._nodes.length; i++) {
      for (let j = i + 1; j < this._nodes.length; j++) {
        const a = this._nodes[i];
        const b = this._nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const gridDist = Math.abs(a.b.ix - b.b.ix) + Math.abs(a.b.iy - b.b.iy);
        if (gridDist <= 3 && dist < this._w * 0.45 && Math.random() < 0.4) {
          this._links.push({
            a, b, dist,
            ph: Math.random(),
            speed: 0.18 + Math.random() * 0.22,
            kind: (Math.random() * 4) | 0,
          });
        }
      }
    }
    this._links.sort((u, v) => u.dist - v.dist);
    this._links = this._links.slice(0, maxLinks);
  }

  play() {
    if (this._running) return Promise.resolve();
    this._running = true;
    this._start = performance.now();
    this._resize();
    window.addEventListener('resize', this._onResize = () => this._resize(), { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', this._onResize, { passive: true });
    }
    return new Promise((res) => {
      this._resolve = res;
      this._loop();
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._running = false;
    cancelAnimationFrame(this._raf);
    window.removeEventListener('resize', this._onResize);
    if (window.visualViewport && this._onResize) {
      window.visualViewport.removeEventListener('resize', this._onResize);
    }
  }

  _finish(skipped) {
    if (!this._running) return;
    this._running = false;
    cancelAnimationFrame(this._raf);
    this._onPhase('done');
    this._onProgress(1);
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r(skipped);
    }
  }

  _loop = () => {
    if (!this._running) return;
    let t = (performance.now() - this._start) / 1000;
    if (t >= this.duration) t = this.duration;
    this._draw(t);
    this._onProgress(clamp(t / this.duration, 0, 1));
    if (t >= this.duration) {
      if (!this._holdSignaled) {
        this._holdSignaled = true;
        this._onPhase('loading');
      }
      return;
    }
    this._raf = requestAnimationFrame(this._loop);
  };

  complete() { this._finish(false); }

  _drawBuilding(ctx, b, lit) {
    const ox = this._ox;
    const oy = this._oy;

    // top face corners (roof)
    const tNW = this._iso(b.ix, b.iy, b.h);
    const tNE = this._iso(b.ix + 1, b.iy, b.h);
    const tSE = this._iso(b.ix + 1, b.iy + 1, b.h);
    const tSW = this._iso(b.ix, b.iy + 1, b.h);
    // bottom (ground) of the box
    const bNW = this._iso(b.ix, b.iy, 0);
    const bNE = this._iso(b.ix + 1, b.iy, 0);
    const bSE = this._iso(b.ix + 1, b.iy + 1, 0);
    const bSW = this._iso(b.ix, b.iy + 1, 0);

    const sx = (p) => ox + p.x;
    const sy = (p) => oy + p.y;

    // Left face (darker)
    ctx.beginPath();
    ctx.moveTo(sx(bNW), sy(bNW));
    ctx.lineTo(sx(tNW), sy(tNW));
    ctx.lineTo(sx(tSW), sy(tSW));
    ctx.lineTo(sx(bSW), sy(bSW));
    ctx.closePath();
    ctx.fillStyle = `rgba(12, 22, 48, ${0.75 + 0.2 * lit})`;
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,140,220,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Right face
    ctx.beginPath();
    ctx.moveTo(sx(bNE), sy(bNE));
    ctx.lineTo(sx(tNE), sy(tNE));
    ctx.lineTo(sx(tSE), sy(tSE));
    ctx.lineTo(sx(bSE), sy(bSE));
    ctx.closePath();
    ctx.fillStyle = `rgba(8, 16, 36, ${0.8 + 0.15 * lit})`;
    ctx.fill();
    ctx.stroke();

    // Roof (top) — lit
    ctx.beginPath();
    ctx.moveTo(sx(tNW), sy(tNW));
    ctx.lineTo(sx(tNE), sy(tNE));
    ctx.lineTo(sx(tSE), sy(tSE));
    ctx.lineTo(sx(tSW), sy(tSW));
    ctx.closePath();
    ctx.fillStyle = `rgba(18, 32, 64, ${0.85 + 0.15 * lit})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(45, 136, 255,${0.2 + 0.35 * lit})`;
    ctx.stroke();

    // Window rows on left + right faces
    if (lit > 0.15) {
      const floors = b.floors;
      for (let f = 1; f < floors; f++) {
        const z = (f / floors) * b.h;
        // left face windows
        const l0 = this._iso(b.ix + 0.25, b.iy, z);
        const l1 = this._iso(b.ix + 0.25, b.iy + 0.75, z);
        const flicker = 0.45 + 0.55 * Math.abs(Math.sin(performance.now() * 0.002 + f + b.ix));
        ctx.strokeStyle = b.col;
        ctx.globalAlpha = lit * b.lit * flicker * 0.85;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(sx(l0), sy(l0));
        ctx.lineTo(sx(l1), sy(l1));
        ctx.stroke();
        // right face
        const r0 = this._iso(b.ix + 0.25, b.iy + 1, z);
        const r1 = this._iso(b.ix + 0.75, b.iy + 1, z);
        ctx.beginPath();
        ctx.moveTo(sx(r0), sy(r0));
        ctx.lineTo(sx(r1), sy(r1));
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Antenna on roof center
    if (lit > 0.25) {
      const cx = (sx(tNW) + sx(tNE) + sx(tSE) + sx(tSW)) / 4;
      const cy = (sy(tNW) + sy(tNE) + sy(tSE) + sy(tSW)) / 4;
      ctx.fillStyle = `rgba(45, 136, 255,${0.75 * lit})`;
      ctx.beginPath();
      ctx.arc(cx, cy, 2.8, 0, 6.28);
      ctx.fill();
    }
  }

  _draw(t) {
    const ctx = this.ctx;
    const w = this._w;
    const h = this._h;
    if (!ctx || w < 2 || h < 2) return;

    // Sky
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#050a18');
    g.addColorStop(0.45, '#0a1430');
    g.addColorStop(1, '#070b19');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);

    // Ground plane hint (iso diamond grid under city)
    ctx.strokeStyle = 'rgba(45, 136, 255,0.07)';
    ctx.lineWidth = 1;
    for (let i = -2; i < 14; i++) {
      const a = this._iso(i, -2, 0);
      const b = this._iso(i, 12, 0);
      ctx.beginPath();
      ctx.moveTo(this._ox + a.x, this._oy + a.y);
      ctx.lineTo(this._ox + b.x, this._oy + b.y);
      ctx.stroke();
      const c = this._iso(-2, i, 0);
      const d = this._iso(12, i, 0);
      ctx.beginPath();
      ctx.moveTo(this._ox + c.x, this._oy + c.y);
      ctx.lineTo(this._ox + d.x, this._oy + d.y);
      ctx.stroke();
    }

    const reveal = smooth(0.1, 1.8, t);

    // Isometric buildings with 3D faces
    for (const b of this._buildings) {
      const lit = clamp(smooth(0.3, 2.4, t - b.delay), 0, 1) * reveal;
      this._drawBuilding(ctx, b, lit);
    }

    // Network lines between rooftops
    const linkA = smooth(1.5, 3.0, t) * (1 - smooth(this.duration - 5, this.duration - 2.5, t));
    if (linkA > 0.02) {
      ctx.lineCap = 'round';
      for (const L of this._links) {
        const pulse = 0.5 + 0.5 * Math.sin(t * 2.5 + L.ph * 6.28);
        ctx.strokeStyle = `rgba(45, 136, 255,${linkA * pulse * 0.7})`;
        ctx.lineWidth = 2.4;
        ctx.beginPath();
        ctx.moveTo(L.a.x, L.a.y);
        ctx.lineTo(L.b.x, L.b.y);
        ctx.stroke();
        ctx.strokeStyle = `rgba(45, 136, 255,${linkA * pulse * 0.22})`;
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(L.a.x, L.a.y);
        ctx.lineTo(L.b.x, L.b.y);
        ctx.stroke();
      }
    }

    // Logos MOVING on the lines (not static top cards)
    const pktA = smooth(2.0, 3.4, t) * (1 - smooth(this.duration - 5, this.duration - 2.5, t));
    if (pktA > 0.02) {
      for (const L of this._links) {
        const tt = (L.ph + t * L.speed) % 1;
        const x = lerp(L.a.x, L.b.x, tt);
        const y = lerp(L.a.y, L.b.y, tt);
        const k = KINDS[L.kind % 4];

        ctx.globalAlpha = pktA;
        // pill badge that travels
        const label = k.name;
        ctx.font = '800 11px Orbitron, sans-serif';
        const tw = ctx.measureText(label).width;
        const pw = tw + 16;
        const ph = 18;
        ctx.fillStyle = 'rgba(5,10,22,0.92)';
        ctx.strokeStyle = k.col;
        ctx.lineWidth = 1.5;
        const rx = x - pw / 2;
        const ry = y - ph - 6;
        this._roundRect(ctx, rx, ry, pw, ph, 8);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = k.col;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, ry + ph / 2);

        // bright packet dot
        ctx.fillStyle = k.col;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, 6.28);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(x, y, 1.8, 0, 6.28);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // Soft vignette around center for SOS readability
    const vg = ctx.createRadialGradient(w / 2, h * 0.55, h * 0.1, w / 2, h * 0.55, h * 0.55);
    vg.addColorStop(0, 'rgba(7,11,25,0.5)');
    vg.addColorStop(0.55, 'rgba(7,11,25,0.15)');
    vg.addColorStop(1, 'rgba(7,11,25,0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

export { LoadNugFallback as LoadNugScene };
