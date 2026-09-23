// Camera QR scanner for the recipient field.
//
// A Standard (Generation) address makes about the densest QR code there is,
// some 170 modules a side, and a web page gets only the camera it asks for.
// Left to the defaults, a phone hands over any back camera at 1080p with
// whatever focus it likes, and such a code does not read, while the phone's
// own camera app reads it from the same distance. So this scanner asks:
//
// - for a back camera that can focus. "Any back camera" on a phone with
//   several lenses is sometimes the ultra-wide, whose focus is fixed and
//   cannot be told otherwise. The first time, the cameras are tried in turn
//   until one offers continuous focus; the choice is remembered, and a button
//   switches by hand when the guess is wrong;
// - for continuous focus and, where offered, 2x zoom, so the phone can be
//   held further back, where every lens focuses, with the code still large;
// - to read only the centred square the guide shows, which is fewer pixels
//   to move and decode than the whole frame.
//
// Two readers look at each square: the browser's own detector where there is
// one (fast, weak on dense codes), and zxing in a worker (slower, strong on
// them), so nothing heavy runs on the thread that draws the preview. A dim
// line says what the camera actually gave, because which of these a given
// phone grants to a web page only that phone can tell.

import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconBulb, IconBulbOff, IconCameraRotate, IconPhoto, IconZoomIn, IconZoomOut } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { NATIVE } from '../app/platform';
import { decodeQr } from '../util/qrDecode';
import type { QrWorkerRequest, QrWorkerResponse } from '../util/qrWorker';

interface Detector {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => Detector;
  }
}

/** What a camera says it can do, as far as this scanner cares. */
interface CameraCaps {
  torch?: boolean;
  focusMode?: string[];
  zoom?: { min: number; max: number; step?: number };
}

/** The share of the frame's short side the guide square, and the read, cover. */
const GUIDE = 0.86;
const REMEMBERED_CAMERA = 'neptune-vault.scanner.camera';

function remembered(): string | null {
  try {
    return localStorage.getItem(REMEMBERED_CAMERA);
  } catch {
    return null;
  }
}
function remember(deviceId: string | null): void {
  try {
    if (deviceId) localStorage.setItem(REMEMBERED_CAMERA, deviceId);
    else localStorage.removeItem(REMEMBERED_CAMERA);
  } catch {
    // Storage unavailable: the choice is made again next time.
  }
}

function capsOf(track: MediaStreamTrack | null): CameraCaps {
  return (track?.getCapabilities?.() ?? {}) as CameraCaps;
}

/** The back cameras, in the browser's order; every camera where none says it faces back (a laptop). */
async function backCameras(): Promise<MediaDeviceInfo[]> {
  const all = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId !== '');
  const back = all.filter((d) => /back|rear|environment/i.test(d.label));
  return back.length > 0 ? back : all;
}

function openCamera(deviceId: string | null): Promise<MediaStream> {
  const size = { width: { ideal: 1920 }, height: { ideal: 1080 } };
  return navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size },
    audio: false,
  });
}

export function QrScanner({ opened, onClose, onResult }: { opened: boolean; onClose: () => void; onResult: (text: string) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped by "Try again": a dismissed permission prompt asks again; a
  // blocked one refuses at once, and the message says where to allow it.
  const [attempt, setAttempt] = useState(0);
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState<string | null>(null);
  // The camera picked by hand, which the effect below opens; null lets it choose.
  const [picked, setPicked] = useState<string | null>(null);
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number } | null>(null);
  const [zoomed, setZoomed] = useState(true);
  const [portrait, setPortrait] = useState(true);
  const [status, setStatus] = useState('');

  // A code on screen or in a saved picture: read from an image instead of
  // the camera. For a desktop without a camera, and for a screenshot sent
  // by the payee. The image can be chosen or pasted.
  const imageInput = useRef<HTMLInputElement>(null);
  const [reading, setReading] = useState(false);
  const readImage = async (blob: Blob) => {
    setReading(true);
    try {
      const text = await decodeImage(blob);
      if (text) onResult(text);
      else setError('No QR code found in that image. Try a sharper or closer picture of the code.');
    } catch {
      setError('That file could not be read as an image.');
    } finally {
      setReading(false);
    }
  };
  useEffect(() => {
    if (!opened) return;
    const onPaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find((i) => i.kind === 'file' && i.type.startsWith('image/'));
      const blob = item?.getAsFile();
      if (!blob) return;
      event.preventDefault();
      void readImage(blob);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
    // readImage only calls setters and the latest onResult.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, onResult]);
  // The camera's options are set as a whole, so each change repeats the rest.
  const options = useRef({ focus: false, zoom: null as number | null, torch: false });

  const applyOptions = async (change: Partial<{ focus: boolean; zoom: number | null; torch: boolean }>) => {
    const track = trackRef.current;
    if (!track) return;
    const next = { ...options.current, ...change };
    const set: Record<string, unknown> = {};
    if (next.focus) set.focusMode = 'continuous';
    if (next.zoom !== null) set.zoom = next.zoom;
    if (next.torch) set.torch = true;
    else if (options.current.torch) set.torch = false;
    // Nothing to ask for: a camera that offers none of these is left alone.
    if (Object.keys(set).length > 0) await track.applyConstraints({ advanced: [set as MediaTrackConstraintSet] });
    options.current = next;
  };

  const toggleTorch = async () => {
    try {
      await applyOptions({ torch: !torchOn });
      setTorchOn((v) => !v);
    } catch {
      setTorchAvailable(false);
    }
  };

  const toggleZoom = async () => {
    if (!zoomRange) return;
    const to = zoomed ? zoomRange.min : Math.min(2, zoomRange.max);
    try {
      await applyOptions({ zoom: to });
      setZoomed((v) => !v);
    } catch {
      setZoomRange(null);
    }
  };

  const nextCamera = () => {
    if (cameras.length < 2) return;
    const at = cameras.findIndex((c) => c.deviceId === cameraId);
    const next = cameras[(at + 1) % cameras.length].deviceId;
    remember(next);
    setPicked(next);
  };

  // The newest onResult, without being a reason to restart the camera. A
  // caller that passes an inline function hands over a new one at every
  // render; as a dependency of the effect below that stopped the camera and
  // asked for it again each time, flickering the preview and, on some
  // phones, the permission prompt.
  const onResultRef = useRef(onResult);
  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  useEffect(() => {
    if (!opened) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    let worker: Worker | null = null;
    let workerBusy = false;
    let workerBroken = false;
    let readerMillis = 0;
    try {
      worker = new Worker(new URL('../util/qrWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      workerBroken = true;
    }

    const finish = (text: string) => {
      if (stopped) return;
      stopped = true;
      onResultRef.current(text);
    };

    if (worker) {
      worker.onmessage = ({ data }: MessageEvent<QrWorkerResponse>) => {
        workerBusy = false;
        readerMillis = data.millis;
        // A worker that cannot decode (no OffscreenCanvas, say) is set aside
        // and the page decodes instead: slower, but it reads.
        if (data.error) workerBroken = true;
        else if (data.text) finish(data.text);
      };
      worker.onerror = () => {
        workerBusy = false;
        workerBroken = true;
      };
    }

    const stopStream = () => {
      stream?.getTracks().forEach((t) => t.stop());
      stream = null;
    };

    let passes = 0;
    let passMillis = 0;
    const describe = (track: MediaStreamTrack, caps: CameraCaps, count: number, index: number) => {
      const video = videoRef.current;
      const size = video && video.videoWidth ? `${video.videoWidth} × ${video.videoHeight}` : 'starting';
      const focus = options.current.focus ? 'continuous' : caps.focusMode && caps.focusMode.length > 0 ? `not continuous (${caps.focusMode.join(', ')})` : 'not offered';
      const zoom = options.current.zoom !== null ? `${options.current.zoom}×` : caps.zoom ? 'off' : 'not offered';
      const readers = [detector ? 'built-in' : null, worker && !workerBroken ? 'zxing' : workerBroken ? 'zxing on the page' : null].filter(Boolean).join(' + ');
      const pace = passes > 0 ? ` · ${Math.round(passMillis)} ms a look${readerMillis ? `, zxing ${Math.round(readerMillis)} ms` : ''}` : '';
      const which = count > 1 ? `camera ${index + 1} of ${count}` : 'the only camera';
      setStatus(`${size} · ${which}${track.label ? ` (${track.label})` : ''} · focus: ${focus} · zoom: ${zoom} · ${readers}${pace}`);
    };

    const tick = async (track: MediaStreamTrack, caps: CameraCaps, count: number, index: number) => {
      const video = videoRef.current;
      if (stopped || !video) return;
      if (video.readyState >= 2 && video.videoWidth > 0) {
        const started = performance.now();
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const side = Math.floor(Math.min(vw, vh) * GUIDE);
        const sx = Math.floor((vw - side) / 2);
        const sy = Math.floor((vh - side) / 2);
        try {
          const bitmap = await createImageBitmap(video, sx, sy, side, side);
          let handedOver = false;
          try {
            if (detector) {
              const codes = await detector.detect(bitmap);
              if (codes.length > 0) return finish(codes[0].rawValue);
            }
            if (worker && !workerBroken && !workerBusy) {
              workerBusy = true;
              const request: QrWorkerRequest = { id: passes, bitmap };
              worker.postMessage(request, [bitmap]);
              handedOver = true;
            } else if (workerBroken) {
              // No worker to hand to: read the square here.
              const canvas = document.createElement('canvas');
              canvas.width = side;
              canvas.height = side;
              const ctx = canvas.getContext('2d', { willReadFrequently: true });
              if (ctx) {
                ctx.drawImage(bitmap, 0, 0);
                const text = await decodeQr(ctx.getImageData(0, 0, side, side));
                if (text) return finish(text);
              }
            }
          } finally {
            if (!handedOver) bitmap.close();
          }
        } catch {
          // A frame that cannot be read is normal; look at the next one.
        }
        passes += 1;
        const took = performance.now() - started;
        passMillis = passes === 1 ? took : passMillis * 0.8 + took * 0.2;
        if (passes % 5 === 1) describe(track, caps, count, index);
      }
      if (!stopped) setTimeout(() => void tick(track, caps, count, index), 150);
    };

    void (async () => {
      try {
        setStatus('Opening the camera…');
        const wanted = picked ?? remembered();
        try {
          stream = await openCamera(wanted);
        } catch (e) {
          // A remembered camera that has gone (another phone's id, a camera unplugged): start afresh.
          if (!wanted) throw e;
          remember(null);
          stream = await openCamera(null);
        }
        if (stopped) return stopStream();

        // Labels, and with them which cameras face back, are only given once
        // the camera permission is.
        let list = await backCameras();
        if (stopped) return stopStream();
        let track: MediaStreamTrack | null = stream.getVideoTracks()[0] ?? null;
        let caps = capsOf(track);

        // First time, and the camera handed over cannot keep focusing: look
        // for one that can. Each try opens a camera, so this is done once
        // and the answer kept.
        // Only where the browser speaks of focus at all: Safari reports no focus
        // modes for any camera, and opening each in turn there would find nothing.
        const speaksOfFocus = Boolean((navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>).focusMode);
        if (!wanted && speaksOfFocus && track && !caps.focusMode?.includes('continuous') && list.length > 1) {
          setStatus('Looking for the camera that can focus…');
          const first = track.getSettings().deviceId ?? null;
          // One camera at a time: many phones refuse a second while one is
          // open, so the one in hand is let go before the next is tried.
          stopStream();
          track = null;
          for (const candidate of list) {
            if (stopped) return;
            if (candidate.deviceId === first) continue;
            try {
              const tryStream = await openCamera(candidate.deviceId);
              const tryTrack = tryStream.getVideoTracks()[0] ?? null;
              if (tryTrack && capsOf(tryTrack).focusMode?.includes('continuous')) {
                stream = tryStream;
                track = tryTrack;
                break;
              }
              tryStream.getTracks().forEach((t) => t.stop());
            } catch {
              // A camera that will not open is passed over.
            }
          }
          // None can: back to the one the browser chose.
          if (!track) {
            if (stopped) return;
            stream = await openCamera(first);
            track = stream.getVideoTracks()[0] ?? null;
          }
          caps = capsOf(track);
        }
        if (stopped || !track) return stopStream();
        const usedId = track.getSettings().deviceId ?? null;
        if (usedId) remember(usedId);
        list = list.length > 0 ? list : await backCameras();
        setCameras(list);
        setCameraId(usedId);

        // The dialog draws its contents a moment after it opens. A camera that
        // is quick to open (permission already given, a fast phone) can be
        // ready before the video element exists; wait for it briefly rather
        // than give up with the scanner showing a black box.
        let video = videoRef.current;
        for (let i = 0; !video && !stopped && i < 40; i++) {
          await new Promise((r) => setTimeout(r, 50));
          video = videoRef.current;
        }
        // The camera can take a second or two to open, and the scanner may
        // have been closed by then. The cleanup below ran when `stream` was
        // still null, so nothing else will ever stop these tracks: without
        // this the camera stays on, light and all, with no scanner on screen.
        if (stopped || !video) return stopStream();

        trackRef.current = track;
        setTorchAvailable(Boolean(caps.torch));
        setTorchOn(false);
        const zoom = caps.zoom && caps.zoom.max >= 1.5 ? { min: caps.zoom.min, max: caps.zoom.max } : null;
        setZoomRange(zoom);
        setZoomed(true);
        options.current = { focus: false, zoom: null, torch: false };
        try {
          await applyOptions({ focus: Boolean(caps.focusMode?.includes('continuous')), zoom: zoom ? Math.min(2, zoom.max) : null });
        } catch {
          // Offered but refused: the scan goes on with what the camera does by itself.
        }

        video.srcObject = stream;
        await video.play();
        setPortrait(video.videoHeight >= video.videoWidth);
        const index = Math.max(0, list.findIndex((c) => c.deviceId === usedId));
        describe(track, caps, list.length, index);
        void tick(track, caps, list.length, index);
      } catch (e) {
        setError(cameraProblem(e));
      }
    })();

    return () => {
      stopped = true;
      stopStream();
      worker?.terminate();
      trackRef.current = null;
    };
    // applyOptions reads refs only; it is not a reason to restart the camera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, attempt, picked]);

  const at = cameras.findIndex((c) => c.deviceId === cameraId);

  return (
    <Modal opened={opened} onClose={onClose} title="Scan a QR code" fullScreen padding="md">
      <Stack>
        {error ? (
          <Text c="red" size="sm">
            {error}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            Fill the square with the code and hold steady. If it is blurry, move back a little. Dense codes can take a moment.
          </Text>
        )}
        <div className="vault-scan">
          <video ref={videoRef} playsInline muted />
          {!error && <div className={portrait ? 'vault-scan-guide portrait' : 'vault-scan-guide'} style={{ ['--guide' as string]: `${GUIDE * 100}%` }} aria-hidden />}
        </div>
        {!error && (torchAvailable || zoomRange || cameras.length > 1) && (
          <Group gap="xs" justify="center">
            {torchAvailable && (
              <Button variant="light" size="compact-md" className="vault-tap" leftSection={torchOn ? <IconBulbOff size={16} stroke={1.8} /> : <IconBulb size={16} stroke={1.8} />} onClick={() => void toggleTorch()}>
                {torchOn ? 'Torch off' : 'Torch on'}
              </Button>
            )}
            {zoomRange && (
              <Button variant="light" size="compact-md" className="vault-tap" leftSection={zoomed ? <IconZoomOut size={16} stroke={1.8} /> : <IconZoomIn size={16} stroke={1.8} />} onClick={() => void toggleZoom()}>
                {zoomed ? 'Zoom out' : 'Zoom in'}
              </Button>
            )}
            {cameras.length > 1 && (
              <Button variant="light" size="compact-md" className="vault-tap" leftSection={<IconCameraRotate size={16} stroke={1.8} />} onClick={nextCamera}>
                Camera {at + 1} of {cameras.length}
              </Button>
            )}
          </Group>
        )}
        <input
          ref={imageInput}
          type="file"
          accept="image/*"
          aria-label="Image with a QR code"
          hidden
          onChange={(e) => {
            const chosen = e.currentTarget.files?.[0];
            e.currentTarget.value = '';
            if (chosen) void readImage(chosen);
          }}
        />
        <Button variant="subtle" className="vault-tap" leftSection={<IconPhoto size={16} stroke={1.8} />} loading={reading} onClick={() => imageInput.current?.click()}>
          Scan from an image
        </Button>
        <Group grow>
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          {error && (
            <Button
              variant="light"
              onClick={() => {
                setError(null);
                setAttempt((n) => n + 1);
              }}
            >
              Try again
            </Button>
          )}
        </Group>
        {!error && status && (
          <Text size="xs" c="dimmed" className="vault-scan-status" aria-live="off">
            {status}
          </Text>
        )}
      </Stack>
    </Modal>
  );
}

/** The largest side an image is read at: enough for any code, quick to scan. */
const IMAGE_MAX_SIDE = 2000;

/** The text of the QR code in an image file, or null when it holds none. */
async function decodeImage(blob: Blob): Promise<string | null> {
  const bitmap = await createImageBitmap(blob);
  try {
    const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    // A transparent PNG reads as black on black without a white ground.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await decodeQr(ctx.getImageData(0, 0, width, height));
  } finally {
    bitmap.close();
  }
}

/** The browser's refusal, said in terms of what the person can do. */
function cameraProblem(e: unknown): string {
  const name = (e as { name?: string }).name ?? '';
  const message = (e as Error).message ?? String(e);
  if (name === 'NotAllowedError' || /denied/i.test(message)) {
    return NATIVE
      ? "Camera access is blocked. Allow it for Neptune Vault in the system's privacy settings, then try again, or scan from an image or paste the address instead."
      : "Camera access is blocked for this site. Allow it in the browser's site settings (the lock icon by the address, or the app's permissions on the phone), then try again, or scan from an image or paste the address instead.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Scan from an image, or paste the address instead.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again, or paste the address instead.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not offer the camera to web apps here (it needs a secure https address). Paste the address instead.';
  return `Camera not available: ${message}. Paste the address instead.`;
}
