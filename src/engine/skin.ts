import * as THREE from 'three';
import type { BodyModel } from './model';
import type { Layer } from './types';
import { clamp, lerp, rng, smooth } from './math';
import type { SkinLook } from './shader';
const HI = typeof navigator !== 'undefined' && !/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
const TW = HI ? 4096 : 2048, TH = TW / 2;
type Pt = [number, number];
/** the scale lattice shared by the painter (pigment per scale) and the shader (relief per scale) */
export function scaleLattice(model: BodyModel) {
  const n = Math.max(8, model.sp.skin.scales);
  const aspect = [0.15, 0.3, 0.5, 0.7, 0.85].reduce((a, q) => a + model.halfPerim(q), 0) / 5;
  return { n, rows: Math.max(6, Math.round(n * aspect)), aspect };
}
/** optical / structural description of the integument, evaluated per pixel in the shader */
export function makeSkinLook(model: BodyModel, bumpTex: THREE.Texture): SkinLook {
  const sp = model.sp, c = sp.color, k = sp.skin.kind;
  const span = 1 - model.sMin;
  const { n, rows, aspect } = scaleLattice(model);
  const scaled = sp.skin.scales > 0 && (k === 'cycloid' || k === 'ctenoid' || k === 'ganoid');
  const se = c.layers?.find((l) => l.k === 'scaleEdge') as Extract<Layer, { k: 'scaleEdge' }> | undefined;
  return {
    n: n * span, rows, aspect: aspect / span,
    kind: scaled ? (k === 'cycloid' ? 1 : k === 'ctenoid' ? 2 : 3) : k === 'placoid' ? 4 : k === 'warty' || k === 'bony' ? 5 : 0,
    bump: scaled ? clamp(sp.skin.bump, 0.3, 1.4) : clamp(sp.skin.bump, 0.1, 2),
    head0: model.uOf(sp.HL * (k === 'ctenoid' ? 0.58 : 0.76)),
    head1: model.uOf(sp.HL * 1.06),
    edge: new THREE.Color(se?.c ?? '#000000'),
    edgeA: se ? (se.a ?? 0.35) : 0,
    silver: clamp((c.metal ?? 0.08) * 1.5 + (c.iri ?? 0) * 0.4, 0, 1),
    speck: c.trans ? 0.15 : 0.5,
    mottle: k === 'warty' ? 0.26 : k === 'smooth' || k === 'placoid' ? 0.14 : 0.1,
    texBump: 0.0035 * (k === 'warty' ? 2.6 : k === 'bony' ? 1.7 : 1),
    bumpTex,
  };
}
/** anatomical landmarks of the head and flank in texture space (s, h) – shared by albedo and relief */
function landmarks(model: BodyModel) {
  const sp = model.sp, e = sp.eye, m = sp.mouth, hl = sp.HL;
  const hp = (s: number) => model.halfPerim(clamp(s, 0.002, 0.999));
  const oper: Pt[] = [];
  const g0 = model.gills.find((q) => q.kind === 'opercle');
  if (g0) for (let k = 0; k <= 48; k++) { const h = lerp(g0.h0 + 0.02, g0.h1 - 0.02, k / 48); oper.push([g0.edge(h), h]); }
  // free hind margin of every gill cover (the cover itself is geometry – only its contact shadow is painted)
  const gsh: Pt[][] = model.gills.map((q) => Array.from({ length: 33 }, (_, k) => {
    const v = 0.03 + 0.94 * (k / 32), h = lerp(q.h0, q.h1, v);
    return [q.edge(h) + q.over * Math.sqrt(Math.sin(Math.PI * v)), h] as Pt;
  }));
  // preopercle: from behind the eye sweeping down and forward to the jaw angle
  const preop: Pt[] = [];
  if (model.hasOpercle() && e.d > 0) {
    const s0 = Math.max(e.s + e.d * 0.9, hl * 0.62);
    for (let k = 0; k <= 30; k++) {
      const t = k / 30;
      preop.push([s0 + (hl * 0.8 - s0) * 0.15 * Math.sin(Math.PI * t * 0.5) - 0.1 * hl * t * t, 0.42 + 0.4 * t]);
    }
  }
  // maxilla: the upper-jaw bone lying on the cheek above the cleft, broadening to a paddle at the corner
  const maxUp: Pt[] = [], maxLo: Pt[] = [];
  if (model.hasJaw() && m.gape >= 0.055 && model.wrap >= 0 && sp.skin.kind !== 'placoid' && m.lip < 0.75) {
    const { mouthTip: mt, rictus: rc } = model;
    const len = rc.s - mt.s;
    for (let k = 0; k <= 36; k++) {
      const t = k / 36;
      const s = lerp(mt.s + 0.1 * len, rc.s + 0.16 * len, t);
      const hc = model.seamPhi(Math.min(s, rc.s)) / Math.PI;
      const w = (0.003 + 0.17 * m.gape * Math.pow(t, 1.4)) * (1 - smooth(0.9, 1, t) * 0.85);
      maxUp.push([s, hc - w / hp(s)]);
      maxLo.push([s, hc]);
    }
  }
  // naris: strictly one clean nostril per side in front of the eye
  const nares: [number, number, number][] = [];
  if (e.d > 0 && sp.plan !== 'ray' && sp.skin.kind !== 'placoid') {
    const hE = model.phiAtY(Math.max(0.002, e.s), model.normY(e.s, model.eyeYn)) / Math.PI;
    const sn = e.s - Math.min(e.d * 0.72, e.s * 0.42);
    const hMouth = model.hasJaw() && sn <= model.rictus.s ? model.seamPhi(sn) / Math.PI : 1;
    const hn = Math.min(hE - 0.02, hMouth - 0.075);
    if (sn >= 0.01 && hn > 0.055) nares.push([sn, hn, clamp(e.d * 0.044, 0.0011, 0.0026)]);
  }
  // branchiostegal rays: the bony struts of the gill membrane under the throat
  const branch: Pt[][] = [];
  if (model.hasOpercle() && hl > 0.14 && sp.plan === 'fish') {
    for (let i = 0; i < 5; i++) {
      const line: Pt[] = [];
      for (let k = 0; k <= 16; k++) {
        const t = k / 16;
        line.push([lerp(hl * (0.5 + 0.035 * i), hl * (1.0 - 0.025 * i), t), 0.868 + 0.024 * i - 0.012 * Math.sin(Math.PI * t)]);
      }
      branch.push(line);
    }
  }
  // lateral line: one pored scale per column, arching down from the shoulder to the tail base
  const lat: Pt[] = [];
  if (sp.plan === 'fish' && !sp.body.disc && !sp.body.bend && sp.skin.kind !== 'placoid' && hl < 0.6) {
    const cnt = Math.round(clamp(sp.skin.scales > 0 ? sp.skin.scales * (1 - hl) : 70, 24, 110));
    for (let i = 0; i < cnt; i++) {
      const t = (i + 0.5) / cnt;
      lat.push([lerp(hl * 1.03, 0.985, t), 0.33 + 0.17 * Math.pow(t, 1.3)]);
    }
  }
  return { oper, gsh, preop, maxUp, maxLo, nares, branch, lat };
}
/**
 * Texture space: u = s (snout→tail), v = φ / 2π.
 * Patterns are authored in (s, h) with h = φ/π: 0 dorsal midline, 0.5 lateral
 * midline, 1 ventral midline – and mirrored onto both flanks.
 */
export function paintSkin(model: BodyModel, seed: number) {
  const sp = model.sp;
  const c = sp.color;
  const cv = document.createElement('canvas');
  cv.width = TW; cv.height = TH;
  const g = cv.getContext('2d')!;
  // base countershading
  const [a, b] = c.cs ?? [0.3, 0.68];
  const grad = g.createLinearGradient(0, 0, 0, TH / 2);
  grad.addColorStop(0, c.top);
  grad.addColorStop(Math.max(0.01, a * 0.7), c.top);
  grad.addColorStop(Math.min(0.98, (a + b) / 2), c.side);
  grad.addColorStop(Math.min(0.99, b * 1.05), c.belly);
  grad.addColorStop(1, c.belly);
  g.fillStyle = grad;
  g.fillRect(0, 0, TW, TH / 2);
  g.save();
  g.translate(0, TH);
  g.scale(1, -1);
  g.fillRect(0, 0, TW, TH / 2);
  g.restore();
  const spanS = 1 - model.sMin;
  const SX = TW / spanS, OX = (-model.sMin / spanS) * TW;
  // seamless rostral pigmentation blending into the head skin for integrated bills, swords, paddles and saws
  if (model.sMin < 0 && sp.rostrum?.color) {
    const rc = new THREE.Color(sp.rostrum.color);
    const hex = rc.getHex(THREE.SRGBColorSpace);
    const rgb = `${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255}`;
    const uEnd = model.uOf(0.055);
    for (const flip of [false, true]) {
      g.save();
      if (flip) { g.translate(0, TH); g.scale(1, -1); }
      const gx = g.createLinearGradient(0, 0, uEnd * TW, 0);
      gx.addColorStop(0, `rgba(${rgb},0.88)`);
      gx.addColorStop(0.68, `rgba(${rgb},0.55)`);
      gx.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gx;
      g.fillRect(0, 0, uEnd * TW, TH * 0.42);
      g.restore();
    }
  }
  /** run fn twice, in unit (s,h) space for right and left flank (mapped seamlessly from [sMin, 1]) */
  const both = (fn: () => void) => {
    g.save(); g.setTransform(SX, 0, 0, TH / 2, OX, 0); fn(); g.restore();
    g.save(); g.setTransform(SX, 0, 0, -TH / 2, OX, TH); fn(); g.restore();
  };
  /** isotropic ellipse: radius r in SL units at (s,h) */
  const dot = (s: number, h: number, r: number) => {
    const rh = r / model.halfPerim(Math.min(0.999, Math.max(model.sMin + 0.001, s)));
    g.beginPath();
    g.ellipse(s, h, r, Math.min(rh, 0.5), 0, 0, Math.PI * 2);
  };
  const hp = (s: number) => model.halfPerim(Math.min(0.999, Math.max(model.sMin + 0.002, s)));
  const path = (pts: Pt[], ds = 0, dh = 0) => {
    g.beginPath();
    pts.forEach(([s, h], k) => (k ? g.lineTo(s + ds, h + dh) : g.moveTo(s + ds, h + dh)));
  };
  const lattice = scaleLattice(model);
  for (const L of (c.layers ?? []) as Layer[]) {
    switch (L.k) {
      case 'grad': {
        // one vertical soft band masked by a horizontal soft window (no strip banding)
        const col = new THREE.Color(L.c);
        const hex = col.getHex(THREE.SRGBColorSpace);
        const rgb = `${(hex >> 16) & 255},${(hex >> 8) & 255},${hex & 255}`;
        const soft = L.soft ?? 0.04;
        const softU = soft / spanS;
        const tmp = document.createElement('canvas');
        tmp.width = TW; tmp.height = TH / 2;
        const tg = tmp.getContext('2d')!;
        const win = (a0: number, a1: number, px: number, horizontal: boolean, cc: string, sf: number) => {
          const span = a1 - a0 + 2 * sf;
          const gr = horizontal ? tg.createLinearGradient((a0 - sf) * px, 0, (a1 + sf) * px, 0) : tg.createLinearGradient(0, (a0 - sf) * px, 0, (a1 + sf) * px);
          gr.addColorStop(0, `rgba(${cc},0)`);
          gr.addColorStop(Math.min(0.49, sf / span), `rgba(${cc},1)`);
          gr.addColorStop(Math.max(0.51, 1 - sf / span), `rgba(${cc},1)`);
          gr.addColorStop(1, `rgba(${cc},0)`);
          tg.fillStyle = gr;
          tg.fillRect(0, 0, TW, TH / 2);
        };
        win(L.h0, L.h1, TH / 2, false, rgb, soft);
        tg.globalCompositeOperation = 'destination-in';
        win(model.uOf(L.s0), model.uOf(L.s1), TW, true, '0,0,0', softU);
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.globalAlpha = L.a ?? 1;
        g.drawImage(tmp, 0, 0);
        g.translate(0, TH); g.scale(1, -1);
        g.drawImage(tmp, 0, 0);
        g.restore();
        break;
      }
      case 'bars': {
        both(() => {
          const h0 = L.h0 ?? 0, h1 = L.h1 ?? 1;
          for (const at of L.at) {
            const draw = (w: number, col: string) => {
              g.fillStyle = col;
              g.beginPath();
              const N = 48;
              const edge = (i: number, sgn: number) => {
                const h = h0 + (h1 - h0) * (i / N);
                const off = (L.wob ?? 0) * Math.sin(h * 9 + at * 40) + (L.slant ?? 0) * (h - 0.5);
                const ww = w * (0.6 + 0.4 * Math.sin(Math.PI * Math.min(1, (h - h0) / (h1 - h0) + 0.0001)) ** 0.3);
                g.lineTo(at + off + (sgn * ww) / 2, h);
              };
              for (let i = 0; i <= N; i++) edge(i, -1);
              for (let i = N; i >= 0; i--) edge(i, 1);
              g.closePath();
              g.fill();
            };
            if (L.edge) draw(L.w + (L.ew ?? 0.012) * 2, L.edge);
            draw(L.w, L.c);
          }
        });
        break;
      }
      case 'stripe': {
        both(() => {
          const s0 = L.s0 ?? 0, s1 = L.s1 ?? 1;
          g.fillStyle = L.c;
          if (L.glow) { g.shadowColor = L.c; g.shadowBlur = 6; }
          g.beginPath();
          const N = 96;
          for (let i = 0; i <= N; i++) {
            const s = s0 + (s1 - s0) * (i / N);
            const tp = 1 - (L.taper ?? 0) * (i / N);
            const w = (L.w * tp) / hp(s) * 0.5;
            g.lineTo(s, L.h + (L.wob ?? 0) * Math.sin(s * 30) - w / 2);
          }
          for (let i = N; i >= 0; i--) {
            const s = s0 + (s1 - s0) * (i / N);
            const tp = 1 - (L.taper ?? 0) * (i / N);
            const w = (L.w * tp) / hp(s) * 0.5;
            g.lineTo(s, L.h + (L.wob ?? 0) * Math.sin(s * 30) + w / 2);
          }
          g.fill();
          g.shadowBlur = 0;
        });
        break;
      }
      case 'spots':
      case 'blotch': {
        const r2 = rng(seed + (L.seed ?? 0) + L.n);
        const pts: [number, number, number][] = [];
        for (let i = 0; i < L.n; i++) {
          const s = (L.s0 ?? 0.02) + r2() * ((L.s1 ?? 0.99) - (L.s0 ?? 0.02));
          const h = (L.h0 ?? 0) + r2() * ((L.h1 ?? 1) - (L.h0 ?? 0));
          const rv = L.k === 'spots' ? (L.rv ?? 0.4) : 0.6;
          pts.push([s, h, L.r * (1 - rv / 2 + r2() * rv)]);
        }
        both(() => {
          for (const [s, h, r] of pts) {
            if (L.k === 'blotch') {
              g.fillStyle = L.c;
              const rr = rng(Math.floor(s * 1e5 + h * 1e3));
              for (let j = 0; j < 7; j++) {
                dot(s + (rr() - 0.5) * r * 1.4, h + (rr() - 0.5) * (r / hp(s)) * 1.4, r * (0.45 + rr() * 0.5));
                g.fill();
              }
            } else {
              if (L.k === 'spots' && L.ring) { g.fillStyle = L.ring; dot(s, h, r * 1.45); g.fill(); }
              g.fillStyle = L.c;
              dot(s, h, r); g.fill();
            }
          }
        });
        break;
      }
      case 'reticulate': {
        // snakeskin / mosaic net: irregular cell outlines, drawn in pixel space for even stroke width
        const r2 = rng(seed + (L.seed ?? 0) + 913);
        const s0 = L.s0 ?? 0.2, s1 = L.s1 ?? 0.98, h0 = L.h0 ?? 0.08, h1 = L.h1 ?? 0.8;
        const ds = (s1 - s0) / L.n;
        const cells: [number, number][] = [];
        for (let sc = s0 + ds / 2; sc < s1; sc += ds) {
          const dh = ds / hp(sc);
          for (let hc = h0 + dh / 2; hc < h1; hc += dh) cells.push([sc + (r2() - 0.5) * ds * 0.45, hc + (r2() - 0.5) * dh * 0.45]);
        }
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.strokeStyle = L.c;
        g.lineWidth = Math.max(1, (L.w ?? 0.003) * TW * 0.7);
        g.lineJoin = 'round';
        for (const flip of [false, true]) {
          for (const [sc, hc] of cells) {
            const rr = rng(Math.floor(sc * 1e5 + hc * 1e4));
            g.globalAlpha = smooth(s0, s0 + 0.05, sc) * (1 - smooth(s1 - 0.05, s1, sc)) * smooth(h0, h0 + 0.06, hc) * (1 - smooth(h1 - 0.12, h1, hc));
            g.beginPath();
            const K = 7, a0 = rr() * 6.28;
            for (let k = 0; k <= K; k++) {
              const aa = a0 + (k / K) * Math.PI * 2;
              const rad = ds * (0.4 + rr() * 0.16);
              const x = model.uOf(sc + Math.cos(aa) * rad) * TW;
              const yy = (hc + (Math.sin(aa) * rad) / hp(sc)) * (TH / 2);
              const y = flip ? TH - yy : yy;
              if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.stroke();
          }
        }
        g.restore();
        break;
      }
      case 'scaleFill': {
        // a pigment spot in the centre of every scale (parrotfishes, some wrasses) – on the shader's lattice
        const { n, rows } = lattice;
        const dx = 1 / n, dh = 1 / rows, rr = L.r ?? 0.34;
        g.save();
        g.setTransform(1, 0, 0, 1, 0, 0);
        g.fillStyle = L.c;
        g.globalAlpha = L.a ?? 0.85;
        for (const flip of [false, true]) {
          for (let i = Math.floor(n * Math.max(L.s0 ?? 0, sp.HL * 0.9)); i < n; i++) {
            for (let j = 0; j < rows; j++) {
              const sc = (i + 0.5 + (j % 2) * 0.5) * dx, hc = (j + 0.5) * dh;
              if (hc < (L.h0 ?? 0.04) || hc > (L.h1 ?? 0.9) || sc > 0.995) continue;
              const yy = hc * (TH / 2);
              g.beginPath();
              g.ellipse(model.uOf(sc - dx * 0.06) * TW, flip ? TH - yy : yy, (dx * rr / spanS) * TW, dh * rr * 1.1 * (TH / 2), 0, 0, Math.PI * 2);
              g.fill();
            }
          }
        }
        g.restore();
        break;
      }
      case 'waves': {
        if (L.vertical) {
          both(() => {
            g.strokeStyle = L.c;
            g.lineWidth = L.w * 0.25;
            const h0 = L.h0 ?? 0.04, h1 = L.h1 ?? 0.96, s0 = L.s0 ?? 0, s1 = L.s1 ?? 1;
            for (let i = 0; i < L.n; i++) {
              const sb = s0 + (s1 - s0) * ((i + 0.5) / L.n);
              g.beginPath();
              for (let k = 0; k <= 80; k++) {
                const h = h0 + (h1 - h0) * (k / 80);
                const sx = sb + L.amp * 0.02 * Math.sin(h * L.freq + i * 1.7) + (L.slant ?? 0) * (h - 0.5);
                if (k === 0) g.moveTo(sx, h); else g.lineTo(sx, h);
              }
              g.stroke();
            }
          });
          break;
        }
        both(() => {
          g.strokeStyle = L.c;
          const h0 = L.h0 ?? 0.02, h1 = L.h1 ?? 0.98;
          for (let i = 0; i < L.n; i++) {
            const hb = h0 + (h1 - h0) * ((i + 0.5) / L.n);
            g.beginPath();
            const s0 = L.s0 ?? 0, s1 = L.s1 ?? 1;
            for (let k = 0; k <= 120; k++) {
              const s = s0 + (s1 - s0) * (k / 120);
              const h = hb + L.amp * Math.sin(s * L.freq + i * 1.7) / hp(s) * 0.1 + (L.slant ?? 0) * (s - 0.5);
              g.lineWidth = L.w / hp(s) * 0.5;
              if (k === 0) g.moveTo(s, h); else g.lineTo(s, h);
            }
            g.stroke();
          }
        });
        break;
      }
      case 'gills': {
        if (model.gills.length) break; // real slits with moving septal flaps are built by gills.ts
        both(() => {
          g.strokeStyle = L.c;
          for (const at of L.at) {
            g.lineWidth = 0.0025;
            g.beginPath();
            g.moveTo(at, L.h0 ?? 0.38);
            g.quadraticCurveTo(at - 0.006, ((L.h0 ?? 0.38) + (L.h1 ?? 0.72)) / 2, at + 0.002, L.h1 ?? 0.72);
            g.stroke();
          }
        });
        break;
      }
      case 'lateral': {
        both(() => {
          g.strokeStyle = L.c;
          g.lineWidth = (L.w ?? 0.006) / 1.2;
          g.beginPath();
          for (let k = 0; k <= 100; k++) {
            const s = sp.HL * 0.9 + (1 - sp.HL * 0.9) * (k / 100);
            const h = (L.h ?? 0.32) + 0.12 * Math.pow(k / 100, 1.3);
            if (k === 0) g.moveTo(s, h); else g.lineTo(s, h);
          }
          g.stroke();
        });
        break;
      }
      case 'photo': {
        both(() => {
          g.fillStyle = L.c;
          g.shadowColor = L.c; g.shadowBlur = 8;
          for (let i = 0; i < L.n; i++) {
            const s = (L.s0 ?? 0.15) + ((L.s1 ?? 0.9) - (L.s0 ?? 0.15)) * (i / Math.max(1, L.n - 1));
            dot(s, L.h, L.r ?? 0.006); g.fill();
          }
          g.shadowBlur = 0;
        });
        break;
      }
      case 'scaleEdge':
        break; // pigmented scale margins are drawn per pixel by the shader, exactly on the scale relief
    }
  }
  // ── anatomy of the head, painted where the geometry puts it ───────────────
  const lm = landmarks(model);
  both(() => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const line of lm.gsh) {
      // contact shadow of the free gill-cover margin on the shoulder girdle
      for (const [w, col] of [[0.011, 'rgba(8,3,5,0.1)'], [0.0045, 'rgba(26,6,8,0.3)']] as const) {
        g.strokeStyle = col; g.lineWidth = w;
        path(line, 0.0022); g.stroke();
      }
    }
    if (lm.preop.length) {
      g.strokeStyle = 'rgba(0,0,0,0.075)'; g.lineWidth = 0.0016;
      path(lm.preop); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 0.0016;
      path(lm.preop, -0.002); g.stroke();
    }
    if (lm.maxUp.length) {
      g.strokeStyle = 'rgba(0,0,0,0.13)'; g.lineWidth = 0.0018;
      path(lm.maxUp); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.06)'; g.lineWidth = 0.0016;
      path(lm.maxUp, 0, 0.006); g.stroke();
    }
    for (const line of lm.branch) {
      g.strokeStyle = 'rgba(0,0,0,0.05)'; g.lineWidth = 0.0014;
      path(line); g.stroke();
    }
    for (const [sn, hn, rr] of lm.nares) {
      g.fillStyle = 'rgba(255,255,255,0.07)';
      dot(sn, hn, rr * 1.38); g.fill();
      g.fillStyle = 'rgba(12,12,16,0.58)';
      dot(sn, hn, rr); g.fill();
    }
    if (!c.layers?.some((l) => l.k === 'lateral')) {
      g.fillStyle = 'rgba(0,0,0,0.13)';
      for (const [s, h] of lm.lat) { dot(s, h, 0.0011); g.fill(); }
    }
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 16;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  return { tex, canvas: cv };
}
/** grayscale height map: dermal warts / plates and the bony relief of the head (scales are procedural) */
export function paintBump(model: BodyModel, seed: number) {
  const sp = model.sp;
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 512;
  const g = cv.getContext('2d')!;
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, cv.width, cv.height);
  const R = rng(seed ^ 0x9e3779b9);
  const W = cv.width, H = cv.height;
  const k = sp.skin.kind;
  if (k === 'warty' || k === 'bony') {
    for (let i = 0; i < (k === 'warty' ? 2600 : 1400); i++) {
      const x = R() * W, y = R() * H, r = 1 + R() * (k === 'warty' ? 6 : 3);
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.8)');
      gr.addColorStop(1, 'rgba(128,128,128,0)');
      g.fillStyle = gr;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
  }
  const spanB = 1 - model.sMin;
  const SXB = W / spanB, OXB = (-model.sMin / spanB) * W;
  const both = (fn: () => void) => {
    g.save(); g.setTransform(SXB, 0, 0, H / 2, OXB, 0); fn(); g.restore();
    g.save(); g.setTransform(SXB, 0, 0, -H / 2, OXB, H); fn(); g.restore();
  };
  const path = (pts: Pt[], ds = 0, dh = 0) => {
    g.beginPath();
    pts.forEach(([s, h], i) => (i ? g.lineTo(s + ds, h + dh) : g.moveTo(s + ds, h + dh)));
  };
  const dot = (s: number, h: number, r: number) => {
    g.beginPath();
    g.ellipse(s, h, r, Math.min(r / model.halfPerim(clamp(s, model.sMin + 0.001, 0.999)), 0.5), 0, 0, Math.PI * 2);
  };
  const lm = landmarks(model);
  both(() => {
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (lm.oper.length) {
      // radiating striae of the opercle bone, the proud margin, the groove of the gill slit behind it
      const hx = sp.HL * 0.64, hy = 0.36;
      g.strokeStyle = 'rgba(176,176,176,0.2)'; g.lineWidth = 0.0013;
      for (let i = 2; i < lm.oper.length - 2; i += 5) { g.beginPath(); g.moveTo(hx, hy); g.lineTo(lm.oper[i][0] - 0.004, lm.oper[i][1]); g.stroke(); }

    }
    if (lm.preop.length) {
      g.strokeStyle = 'rgba(196,196,196,0.4)'; g.lineWidth = 0.004;
      path(lm.preop, -0.003); g.stroke();
      g.strokeStyle = 'rgba(60,60,60,0.55)'; g.lineWidth = 0.002;
      path(lm.preop); g.stroke();
    }
    if (lm.maxUp.length) {
      g.fillStyle = 'rgba(184,184,184,0.45)';
      g.beginPath();
      lm.maxUp.forEach(([s, h], i) => (i ? g.lineTo(s, h) : g.moveTo(s, h)));
      for (let i = lm.maxLo.length - 1; i >= 0; i--) g.lineTo(lm.maxLo[i][0], lm.maxLo[i][1]);
      g.closePath(); g.fill();
      g.strokeStyle = 'rgba(52,52,52,0.6)'; g.lineWidth = 0.0018;
      path(lm.maxUp); g.stroke();
    }
    for (const line of lm.branch) {
      g.strokeStyle = 'rgba(190,190,190,0.4)'; g.lineWidth = 0.0032;
      path(line, 0, -0.006); g.stroke();
      g.strokeStyle = 'rgba(70,70,70,0.5)'; g.lineWidth = 0.0016;
      path(line); g.stroke();
    }
    for (const [sn, hn, rr] of lm.nares) {
      g.fillStyle = 'rgba(182,182,182,0.42)';
      dot(sn, hn, rr * 1.48); g.fill();
      g.fillStyle = 'rgba(32,32,32,0.88)';
      dot(sn, hn, rr); g.fill();
    }
    g.fillStyle = 'rgba(48,48,48,0.75)';
    for (const [s, h] of lm.lat) { dot(s, h, 0.0013); g.fill(); }
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.anisotropy = 4;
  return tex;
}
