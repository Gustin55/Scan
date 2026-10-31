/** LZW façon TIFF (MSB d'abord, « early change »). */

export function lzwDecode(input: Uint8Array, out: Uint8Array): number {
  const prefix = new Int32Array(4096);
  const suffix = new Uint8Array(4096);
  const length = new Int32Array(4096);
  const first = new Uint8Array(4096);
  for (let i = 0; i < 256; i++) {
    prefix[i] = -1; suffix[i] = i; length[i] = 1; first[i] = i;
  }
  let next = 258;
  let width = 9;
  let bitBuf = 0;
  let bitCnt = 0;
  let pos = 0;
  let o = 0;
  let prev = -1;
  const outLen = out.length;

  const writeCode = (code: number) => {
    const len = length[code];
    let end = o + len - 1;
    let c = code;
    if (end >= outLen) {
      // Tronque proprement si le flux dépasse la taille attendue.
      let skip = end - (outLen - 1);
      while (skip-- > 0) c = prefix[c];
      end = outLen - 1;
    }
    for (let k = end; k >= o; k--) {
      out[k] = suffix[c];
      c = prefix[c];
    }
    o += len;
  };

  while (true) {
    while (bitCnt < width) {
      if (pos >= input.length) return Math.min(o, outLen);
      bitBuf = ((bitBuf << 8) | input[pos++]) >>> 0;
      bitCnt += 8;
    }
    const code = (bitBuf >>> (bitCnt - width)) & ((1 << width) - 1);
    bitCnt -= width;
    bitBuf &= (1 << bitCnt) - 1;

    if (code === 257) break;
    if (code === 256) {
      next = 258; width = 9; prev = -1;
      continue;
    }
    if (prev === -1) {
      writeCode(code);
      prev = code;
      continue;
    }
    if (code < next) {
      writeCode(code);
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first[code];
        length[next] = length[prev] + 1; first[next] = first[prev];
        next++;
      }
    } else {
      // code === next : KwKwK
      if (next < 4096) {
        prefix[next] = prev; suffix[next] = first[prev];
        length[next] = length[prev] + 1; first[next] = first[prev];
        next++;
      }
      writeCode(code);
    }
    prev = code;
    if (next + 1 >= (1 << width) && width < 12) width++;
    if (o >= outLen) break;
  }
  return Math.min(o, outLen);
}

export function lzwEncode(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let bitBuf = 0;
  let bitCnt = 0;
  let width = 9;
  const emit = (code: number) => {
    bitBuf = (bitBuf << width) | code;
    bitCnt += width;
    while (bitCnt >= 8) {
      out.push((bitBuf >>> (bitCnt - 8)) & 0xff);
      bitCnt -= 8;
    }
    bitBuf &= (1 << bitCnt) - 1;
  };
  let dict = new Map<number, number>();
  let next = 258;
  emit(256);
  if (input.length === 0) {
    emit(257);
  } else {
    let w = input[0];
    for (let i = 1; i < input.length; i++) {
      const c = input[i];
      const key = w * 256 + c;
      const found = dict.get(key);
      if (found !== undefined) {
        w = found;
        continue;
      }
      emit(w);
      dict.set(key, next++);
      if (next >= (1 << width) && width < 12) width++;
      // le décodeur augmente la largeur un code plus tôt (early change)
      if (next >= 4094) {
        emit(256);
        dict = new Map();
        next = 258;
        width = 9;
      }
      w = c;
    }
    emit(w);
    // Le décodeur ajoute une entrée après ce code : il peut changer de largeur.
    next++;
    if (next >= (1 << width) && width < 12) width++;
    emit(257);
  }
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff);
  return Uint8Array.from(out);
}

export function packBitsDecode(input: Uint8Array, out: Uint8Array): number {
  let i = 0;
  let o = 0;
  while (i < input.length && o < out.length) {
    const n = (input[i++] << 24) >> 24;
    if (n >= 0) {
      for (let k = 0; k <= n && i < input.length && o < out.length; k++) out[o++] = input[i++];
    } else if (n !== -128) {
      const v = input[i++];
      for (let k = 0; k < 1 - n && o < out.length; k++) out[o++] = v;
    }
  }
  return o;
}
