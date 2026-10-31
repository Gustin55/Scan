/** Image décodée en mémoire : échantillons entiers 16 bits (0..65535), entrelacés. */
export interface Raster {
  width: number;
  height: number;
  /** 1 = niveaux de gris, 3 = RVB. */
  channels: 1 | 3;
  data: Uint16Array;
  /** Profondeur d'origine, pour information. */
  sourceBits: number;
  /** Profil ICC embarqué, s'il existe. */
  icc?: Uint8Array;
}

export function createRaster(width: number, height: number, channels: 1 | 3, sourceBits = 16): Raster {
  return { width, height, channels, sourceBits, data: new Uint16Array(width * height * channels) };
}

/** Réduction par moyenne de boîtes ; renvoie toujours un raster RVB. */
export function downscale(src: Raster, maxEdge: number): Raster {
  const scale = Math.min(1, maxEdge / Math.max(src.width, src.height));
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = createRaster(w, h, 3, src.sourceBits);
  out.icc = src.icc;
  const sc = src.channels;
  const fx = src.width / w;
  const fy = src.height / h;
  const acc = new Float64Array(w * 3);
  const cnt = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    acc.fill(0);
    cnt.fill(0);
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.min(src.height, Math.floor((y + 1) * fy)));
    for (let sy = y0; sy < y1; sy++) {
      const row = sy * src.width;
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * fx);
        const x1 = Math.max(x0 + 1, Math.min(src.width, Math.floor((x + 1) * fx)));
        let r = 0, g = 0, b = 0;
        for (let sx = x0; sx < x1; sx++) {
          const i = (row + sx) * sc;
          if (sc === 3) {
            r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2];
          } else {
            const v = src.data[i]; r += v; g += v; b += v;
          }
        }
        acc[x * 3] += r; acc[x * 3 + 1] += g; acc[x * 3 + 2] += b;
        cnt[x] += x1 - x0;
      }
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 3;
      const n = cnt[x];
      out.data[o] = Math.round(acc[x * 3] / n);
      out.data[o + 1] = Math.round(acc[x * 3 + 1] / n);
      out.data[o + 2] = Math.round(acc[x * 3 + 2] / n);
    }
  }
  return out;
}

/** Convertit un tampon RGBA 8 bits (ImageData) en raster RVB 16 bits. */
export function rasterFromRGBA8(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Raster {
  const out = createRaster(width, height, 3, 8);
  const n = width * height;
  for (let i = 0; i < n; i++) {
    out.data[i * 3] = rgba[i * 4] * 257;
    out.data[i * 3 + 1] = rgba[i * 4 + 1] * 257;
    out.data[i * 3 + 2] = rgba[i * 4 + 2] * 257;
  }
  return out;
}
