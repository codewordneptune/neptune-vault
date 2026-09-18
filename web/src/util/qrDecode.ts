// QR decoding for browsers without a barcode detector of their own (Safari
// on iPhone, Firefox, Chrome on Windows and Linux). The decoder is
// zxing-wasm, a wasm build of zxing-cpp: maintained, and good with the dense
// codes a Standard address makes.
//
// Two things about how it is loaded:
//
// - From this origin only. Left to itself the package fetches its wasm file
//   from a public CDN, which would tell a third party every time someone
//   scans, and would put code from outside the build into the wallet. The
//   file is bundled with the app and the package is pointed at that copy.
// - Only when needed. The decoder is nearly a megabyte, and a browser with
//   its own detector never runs it, so it is imported on first use.

type Reader = typeof import('zxing-wasm/reader');

let ready: Promise<Reader> | null = null;

function load(): Promise<Reader> {
  ready ??= (async () => {
    const [reader, wasm] = await Promise.all([import('zxing-wasm/reader'), import('zxing-wasm/reader/zxing_reader.wasm?url')]);
    await reader.prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasm.default : prefix + path) },
      fireImmediately: true,
    });
    return reader;
  })();
  // A failed load is not remembered: the next frame tries again.
  ready.catch(() => {
    ready = null;
  });
  return ready;
}

/** Start loading the decoder, so the first frame does not wait for it. */
export function warmQrDecoder(): void {
  void load().catch(() => undefined);
}

/** The text of the QR code in `image`, or null when there is none to read. */
export async function decodeQr(image: ImageData): Promise<string | null> {
  const reader = await load();
  const found = await reader.readBarcodes(image, { formats: ['QRCode'], tryHarder: true, maxNumberOfSymbols: 1 });
  const code = found.find((r) => r.isValid && r.text !== '');
  return code ? code.text : null;
}
