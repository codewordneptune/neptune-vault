// QR reading in a browser: vault-qr (wasm) in a worker of its own, so
// nothing heavy runs on the thread that draws the camera's preview. Where
// the worker cannot run (a browser without OffscreenCanvas in workers, say),
// the page reads instead: slower, but it reads.

import type { QrReader } from '../types';
import type { QrWorkerRequest, QrWorkerResponse } from './qrWorker';

type QrModule = typeof import('../../../public/wasm/qr/vault_qr');

let onPage: Promise<QrModule> | null = null;
// Once a worker here has failed to read, later readers start on the page.
let workersFail = false;

/** The package loaded on the page itself, for when there is no worker. */
function pageModule(): Promise<QrModule> {
  onPage ??= (async () => {
    const url = new URL('/wasm/qr/vault_qr.js', location.origin).href;
    const m = (await import(/* @vite-ignore */ url)) as QrModule;
    await m.default();
    return m;
  })();
  // A failed load is not remembered: the next read tries again.
  onPage.catch(() => {
    onPage = null;
  });
  return onPage;
}

export class BrowserQrReader implements QrReader {
  name = 'rxing';
  lastMillis = 0;
  private worker: Worker | null = null;
  private nextId = 0;
  private waiting = new Map<number, (text: string | null) => void>();

  constructor() {
    if (workersFail) {
      this.name = 'rxing on the page';
      return;
    }
    try {
      this.worker = new Worker(new URL('./qrWorker.ts', import.meta.url), { type: 'module' });
      this.worker.onmessage = ({ data }: MessageEvent<QrWorkerResponse>) => this.answer(data);
      this.worker.onerror = () => this.setWorkerAside();
    } catch {
      this.setWorkerAside();
    }
  }

  async read(bitmap: ImageBitmap): Promise<string | null> {
    const worker = this.worker;
    if (worker) {
      const id = ++this.nextId;
      return new Promise((resolve) => {
        this.waiting.set(id, resolve);
        const request: QrWorkerRequest = { id, bitmap };
        worker.postMessage(request, [bitmap]);
      });
    }
    const started = performance.now();
    try {
      const m = await pageModule();
      const image = pixels(bitmap);
      return m.readQr(new Uint8Array(image.data.buffer), image.width, image.height) ?? null;
    } finally {
      bitmap.close();
      this.lastMillis = performance.now() - started;
    }
  }

  close(): void {
    this.worker?.terminate();
    this.worker = null;
    this.settleWaiting();
  }

  private answer(data: QrWorkerResponse): void {
    this.lastMillis = data.millis;
    const resolve = this.waiting.get(data.id);
    this.waiting.delete(data.id);
    // A worker that cannot read is set aside; the page reads from the next frame on.
    if (data.error) this.setWorkerAside();
    resolve?.(data.text);
  }

  private setWorkerAside(): void {
    workersFail = true;
    this.worker?.terminate();
    this.worker = null;
    this.name = 'rxing on the page';
    this.settleWaiting();
  }

  private settleWaiting(): void {
    for (const resolve of this.waiting.values()) resolve(null);
    this.waiting.clear();
  }
}

/** A bitmap's pixels, through a canvas on the page. */
function pixels(bitmap: ImageBitmap): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no 2d context on the page');
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}
