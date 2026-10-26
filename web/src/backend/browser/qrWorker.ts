// Reads QR codes off the main thread. The page hands over a cropped frame
// as an ImageBitmap (transferred, not copied); its pixels are read back here
// and given to vault-qr, so neither step can make the camera preview stutter.
// The package is served untransformed from /wasm/qr, built from this
// repository like the wallet's own.

type QrModule = typeof import('../../../public/wasm/qr/vault_qr');

export interface QrWorkerRequest {
  id: number;
  bitmap: ImageBitmap;
}

export interface QrWorkerResponse {
  id: number;
  text: string | null;
  millis: number;
  error?: string;
}

const ready: Promise<QrModule> = (async () => {
  const url = new URL('/wasm/qr/vault_qr.js', self.location.origin).href;
  const m = (await import(/* @vite-ignore */ url)) as QrModule;
  await m.default();
  return m;
})();

let canvas: OffscreenCanvas | null = null;

function post(response: QrWorkerResponse): void {
  (self as unknown as Worker).postMessage(response);
}

self.onmessage = async ({ data }: MessageEvent<QrWorkerRequest>) => {
  const started = performance.now();
  const { id, bitmap } = data;
  try {
    const m = await ready;
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context in the worker');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    post({ id, text: m.readQr(new Uint8Array(image.data.buffer), image.width, image.height) ?? null, millis: performance.now() - started });
  } catch (e) {
    post({ id, text: null, millis: performance.now() - started, error: e instanceof Error ? e.message : String(e) });
  } finally {
    bitmap.close();
  }
};
