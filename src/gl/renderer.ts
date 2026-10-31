import type { Compiled } from '../core/compile.ts';
import { TONE_LUT_SIZE } from '../core/compile.ts';
import { GRAIN_CELLS, halationSigma } from '../core/pipeline.ts';
import vertSrc from './shaders/quad.vert?raw';
import commonSrc from './shaders/common.glsl?raw';
import stage1Src from './shaders/stage1.frag?raw';
import blurSrc from './shaders/blur.frag?raw';
import finalSrc from './shaders/final.frag?raw';
import beforeSrc from './shaders/before.frag?raw';

/** Image d'aperçu : demi-flottants RGBA (bits), prête pour une texture RGBA16F. */
export interface HalfImage { width: number; height: number; data: Uint16Array }

export interface RenderRequest {
  draft: boolean;
  before: boolean;
}

type Prog = { prog: WebGLProgram; loc: Map<string, WebGLUniformLocation | null> };

interface Target { fb: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

export class RendererError extends Error {}

function fragment(src: string) {
  return `#version 300 es\n${commonSrc}\n${src}`;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private progs: Record<'stage' | 'blur' | 'final' | 'before', Prog>;
  private vao: WebGLVertexArrayObject;
  private src?: WebGLTexture;
  private proxy?: WebGLTexture;
  private trc: WebGLTexture;
  private tone: WebGLTexture;
  private srcSize = { w: 1, h: 1 };
  private proxySize = { w: 1, h: 1 };
  private imageSize = { w: 1, h: 1 };
  private stageTarget?: Target;
  private halo: Target[] = [];
  private haloKey = '';
  private params?: Compiled;
  private trcRef?: Float32Array;
  private renderFormat: { internal: number; type: number };
  private mipmaps: boolean;
  lastFrameMs = 0;

  constructor(readonly canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext('webgl2', {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      alpha: false,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new RendererError('WebGL2 n’est pas disponible dans ce navigateur.');
    this.gl = gl;
    if ('drawingBufferColorSpace' in gl) (gl as unknown as { drawingBufferColorSpace: string }).drawingBufferColorSpace = 'srgb';
    const floatRT = !!gl.getExtension('EXT_color_buffer_float') || !!gl.getExtension('EXT_color_buffer_half_float');
    this.renderFormat = floatRT ? { internal: gl.RGBA16F, type: gl.HALF_FLOAT } : { internal: gl.RGBA8, type: gl.UNSIGNED_BYTE };
    this.mipmaps = floatRT;
    this.progs = {
      stage: this.program(fragment(stage1Src)),
      blur: this.program(fragment(blurSrc)),
      final: this.program(fragment(finalSrc)),
      before: this.program(fragment(beforeSrc)),
    };
    this.vao = gl.createVertexArray()!;
    this.trc = this.lutTexture();
    this.tone = this.lutTexture();
  }

  private program(fs: string): Prog {
    const gl = this.gl;
    const compileShader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new RendererError(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compileShader(gl.VERTEX_SHADER, vertSrc));
    gl.attachShader(prog, compileShader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new RendererError(gl.getProgramInfoLog(prog) ?? 'link');
    return { prog, loc: new Map() };
  }

  private u(p: Prog, name: string) {
    let l = p.loc.get(name);
    if (l === undefined) { l = this.gl.getUniformLocation(p.prog, name); p.loc.set(name, l); }
    return l;
  }

  private lutTexture() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private imageTexture(img: HalfImage, existing?: WebGLTexture) {
    const gl = this.gl;
    const t = existing ?? gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, img.width, img.height, 0, gl.RGBA, gl.HALF_FLOAT, img.data);
    if (this.mipmaps) gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this.mipmaps ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private target(existing: Target | undefined, w: number, h: number): Target {
    const gl = this.gl;
    if (existing && existing.w === w && existing.h === h) return existing;
    if (existing) { gl.deleteFramebuffer(existing.fb); gl.deleteTexture(existing.tex); }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, this.renderFormat.internal, w, h, 0, gl.RGBA, this.renderFormat.type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fb = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fb, tex, w, h };
  }

  /** Charge une nouvelle image : texture d'aperçu, proxy et dimensions pleine résolution. */
  setImage(preview: HalfImage, proxy: HalfImage, imageW: number, imageH: number) {
    this.src = this.imageTexture(preview, this.src);
    this.proxy = this.imageTexture(proxy, this.proxy);
    this.srcSize = { w: preview.width, h: preview.height };
    this.proxySize = { w: proxy.width, h: proxy.height };
    this.imageSize = { w: imageW, h: imageH };
    this.haloKey = '';
  }

  get hasImage() { return !!this.src; }
  get previewSize() { return this.srcSize; }

  setParams(c: Compiled) {
    const gl = this.gl;
    if (c.trc !== this.trcRef) {
      gl.bindTexture(gl.TEXTURE_2D, this.trc);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, c.trcSize, 1, 0, gl.RGBA, gl.FLOAT, c.trc);
      this.trcRef = c.trc;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tone);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, TONE_LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, c.tone);
    this.params = c;
  }

  private bindStage(p: Prog, c: Compiled, src: WebGLTexture) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.trc);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, this.tone);
    gl.uniform1i(this.u(p, 'u_src'), 0);
    gl.uniform1i(this.u(p, 'u_trc'), 1);
    gl.uniform1i(this.u(p, 'u_tone'), 2);
    gl.uniform1i(this.u(p, 'u_trcSize'), c.trcSize);
    gl.uniform1i(this.u(p, 'u_toneSize'), TONE_LUT_SIZE);
    gl.uniform1i(this.u(p, 'u_mode'), c.mode);
    // mat3 GLSL en colonnes : on transpose nos matrices lignes.
    gl.uniformMatrix3fv(this.u(p, 'u_toSrgb'), true, c.toSrgb);
    gl.uniformMatrix3fv(this.u(p, 'u_mixer'), true, c.mixer);
    gl.uniform3fv(this.u(p, 'u_base'), c.base);
    gl.uniform3fv(this.u(p, 'u_dmin'), c.dmin);
    gl.uniform3fv(this.u(p, 'u_drange'), c.drange);
    gl.uniform3fv(this.u(p, 'u_gamma'), c.gamma);
    gl.uniform3fv(this.u(p, 'u_gains'), c.gains);
    gl.uniform3fv(this.u(p, 'u_splitShadows'), c.splitShadows);
    gl.uniform3fv(this.u(p, 'u_splitHighlights'), c.splitHighlights);
    gl.uniform1f(this.u(p, 'u_saturation'), c.saturation);
  }

  private draw(t: Target | null, w: number, h: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fb : null);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Recalcule la carte de halo (basse résolution) si ses paramètres ont changé. */
  private updateHalo(c: Compiled) {
    const key = c.halation.amount > 0
      ? JSON.stringify([c.halation.radius, c.halation.threshold, c.mode, c.base, c.dmin, c.drange, c.gamma, c.gains, c.mixer, c.saturation, c.splitShadows, c.splitHighlights, Array.from(c.tone.subarray(0, 4096).filter((_, i) => i % 97 === 0))])
      : 'off';
    if (key === this.haloKey) return;
    this.haloKey = key;
    if (key === 'off' || !this.proxy) return;
    const gl = this.gl;
    const { w, h } = this.proxySize;
    this.halo[0] = this.target(this.halo[0], w, h);
    this.halo[1] = this.target(this.halo[1], w, h);
    this.halo[2] = this.target(this.halo[2], w, h);
    const sp = this.progs.stage;
    this.bindStage(sp, c, this.proxy);
    gl.uniform1i(this.u(sp, 'u_maskOnly'), 1);
    gl.uniform1f(this.u(sp, 'u_threshold'), c.halation.threshold);
    this.draw(this.halo[0], w, h);
    const sigma = halationSigma(c, w, h);
    const bp = this.progs.blur;
    gl.useProgram(bp.prog);
    gl.uniform1f(this.u(bp, 'u_sigma'), sigma);
    gl.uniform1i(this.u(bp, 'u_radius'), Math.max(1, Math.ceil(sigma * 3)));
    gl.uniform1i(this.u(bp, 'u_src'), 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.halo[0].tex);
    gl.uniform2f(this.u(bp, 'u_dir'), 1, 0);
    this.draw(this.halo[1], w, h);
    gl.bindTexture(gl.TEXTURE_2D, this.halo[1].tex);
    gl.uniform2f(this.u(bp, 'u_dir'), 0, 1);
    this.draw(this.halo[2], w, h);
  }

  /**
   * Rend dans le canvas. En mode brouillon : depuis le proxy, à la moitié de la
   * définition du canvas (mise à l'échelle CSS).
   */
  render(req: RenderRequest, displayW: number, displayH: number) {
    const t0 = performance.now();
    const gl = this.gl;
    const c = this.params;
    if (!this.src || !c) return;
    const scale = req.draft ? 0.5 : 1;
    const w = Math.max(1, Math.round(displayW * scale));
    const h = Math.max(1, Math.round(displayH * scale));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const source = req.draft && this.proxy ? this.proxy : this.src;
    if (req.before) {
      const p = this.progs.before;
      gl.useProgram(p.prog);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, source);
      gl.uniform1i(this.u(p, 'u_src'), 0);
      this.draw(null, w, h);
      this.lastFrameMs = performance.now() - t0;
      return;
    }
    // Pendant un glissement, la carte de halo (coûteuse) est réutilisée ; recalculée au relâchement.
    if (!req.draft || !this.halo[2] || this.haloKey === 'off') this.updateHalo(c);
    this.stageTarget = this.target(this.stageTarget, w, h);
    const sp = this.progs.stage;
    this.bindStage(sp, c, source);
    gl.uniform1i(this.u(sp, 'u_maskOnly'), 0);
    this.draw(this.stageTarget, w, h);

    const fp = this.progs.final;
    gl.useProgram(fp.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.stageTarget.tex);
    gl.uniform1i(this.u(fp, 'u_stage'), 0);
    const hasHalo = c.halation.amount > 0 && !!this.halo[2];
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, hasHalo ? this.halo[2].tex : this.tone);
    gl.uniform1i(this.u(fp, 'u_halo'), 1);
    gl.uniform1i(this.u(fp, 'u_hasHalo'), hasHalo ? 1 : 0);
    gl.uniform1f(this.u(fp, 'u_haloAmount'), c.halation.amount);
    gl.uniform1f(this.u(fp, 'u_sharpen'), c.sharpen.amount);
    gl.uniform1f(this.u(fp, 'u_vigAmount'), c.vignette.amount);
    gl.uniform1f(this.u(fp, 'u_vigMid'), c.vignette.midpoint);
    gl.uniform1f(this.u(fp, 'u_vigFeather'), c.vignette.feather);
    gl.uniform1f(this.u(fp, 'u_grainAmount'), c.grain.amount);
    gl.uniform1f(this.u(fp, 'u_grainRough'), c.grain.roughness);
    gl.uniform1f(this.u(fp, 'u_grainColor'), c.grain.color);
    gl.uniform1f(this.u(fp, 'u_grainLum'), c.grain.luminance);
    const { w: iw, h: ih } = this.imageSize;
    const mn = Math.min(iw, ih), mx = Math.max(iw, ih);
    const gs = GRAIN_CELLS / c.grain.size;
    gl.uniform2f(this.u(fp, 'u_grainScale'), (iw / mn) * gs, (ih / mn) * gs);
    gl.uniform2f(this.u(fp, 'u_aspect'), iw / mx, ih / mx);
    this.draw(null, w, h);
    this.lastFrameMs = performance.now() - t0;
  }

  /** Attend la fin du rendu GPU (mesures de performance). */
  finish() {
    const px = new Uint8Array(4);
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, px);
    return px;
  }

  dispose() {
    const ext = this.gl.getExtension('WEBGL_lose_context');
    ext?.loseContext();
  }
}
