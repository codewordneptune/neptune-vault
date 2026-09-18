// Decodes QR codes off the main thread. The page hands over a cropped frame
// as an ImageBitmap (transferred, not copied); the pixels are read back and
// decoded here, so neither step can make the camera preview stutter.
//
// The decoder is zxing-wasm, loaded from this origin only (see qrDecode.ts
// for why that matters).

import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

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

const ready = prepareZXingModule({
  overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path) },
  fireImmediately: true,
});

let canvas: OffscreenCanvas | null = null;

self.onmessage = async ({ data }: MessageEvent<QrWorkerRequest>) => {
  const started = performance.now();
  const { id, bitmap } = data;
  try {
    await ready;
    if (!canvas || canvas.width !== bitmap.width || canvas.height !== bitmap.height) canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context in the worker');
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const found = await readBarcodes(image, { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
    const code = found.find((r) => r.isValid && r.text !== '');
    const response: QrWorkerResponse = { id, text: code ? code.text : null, millis: performance.now() - started };
    (self as unknown as Worker).postMessage(response);
  } catch (e) {
    const response: QrWorkerResponse = { id, text: null, millis: performance.now() - started, error: e instanceof Error ? e.message : String(e) };
    (self as unknown as Worker).postMessage(response);
  } finally {
    bitmap.close();
  }
};
