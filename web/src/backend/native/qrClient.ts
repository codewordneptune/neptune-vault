// QR reading in the desktop and Android apps: the frame goes to the shell
// (app_read_qr), which reads it with vault-qr compiled for the device.
// Greyscale, so a quarter of the bytes travel, weighted as vault-qr weighs
// colour.

import type { QrReader } from '../types';
import { call, toBase64 } from './bridge';

export class NativeQrReader implements QrReader {
  readonly name = 'rxing in the app';
  lastMillis = 0;
  private canvas: HTMLCanvasElement | null = null;

  async read(bitmap: ImageBitmap): Promise<string | null> {
    const started = performance.now();
    try {
      const { width, height } = bitmap;
      this.canvas ??= document.createElement('canvas');
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      const ctx = this.canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const luma = new Uint8Array(width * height);
      for (let i = 0, j = 0; i < luma.length; i += 1, j += 4) luma[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
      return await call<string | null>('app_read_qr', { luma: toBase64(luma), width });
    } finally {
      bitmap.close();
      this.lastMillis = performance.now() - started;
    }
  }

  close(): void {
    this.canvas = null;
  }
}
