// Camera QR scanner for the recipient field. Uses the browser's barcode
// detector where it exists (Chrome on Android) and falls back to zxing-wasm
// on video frames elsewhere (Safari, Firefox; see util/qrDecode). Generation
// addresses make a version-40 code, so frames are captured at the camera's
// full resolution.

import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconBulb, IconBulbOff } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

import { decodeQr, warmQrDecoder } from '../util/qrDecode';

interface Detector {
  detect(source: ImageBitmapSource): Promise<{ rawValue: string }[]>;
}
declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats: string[] }) => Detector;
  }
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
  // Whether the camera was asked to keep focusing. Camera options are set as
  // a whole, so whatever sets one of them later (the torch) must repeat this.
  const continuousFocus = useRef(false);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn, ...(continuousFocus.current ? { focusMode: 'continuous' } : {}) } as MediaTrackConstraintSet] });
      setTorchOn((v) => !v);
    } catch {
      setTorchAvailable(false);
    }
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
    const canvas = document.createElement('canvas');
    const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    // Without a detector of its own the browser needs the bundled decoder:
    // fetched now, while the camera opens, so the first frame does not wait.
    if (!detector) warmQrDecoder();

    const finish = (text: string) => {
      if (stopped) return;
      stopped = true;
      onResultRef.current(text);
    };

    const tick = async () => {
      const video = videoRef.current;
      if (stopped || !video || video.readyState < 2) {
        if (!stopped) setTimeout(() => void tick(), 120);
        return;
      }
      try {
        if (detector) {
          const codes = await detector.detect(video);
          if (codes.length > 0) return finish(codes[0].rawValue);
        } else {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (ctx) {
            ctx.drawImage(video, 0, 0);
            const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const text = await decodeQr(image);
            if (text) return finish(text);
          }
        }
      } catch {
        // A frame that cannot be decoded is normal; try the next one.
      }
      if (!stopped) setTimeout(() => void tick(), 120);
    };

    void (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        // The camera can take a second or two to open, and the scanner may
        // have been closed by then. The cleanup below ran when `stream` was
        // still null, so nothing else will ever stop these tracks: without
        // this the camera stays on, light and all, with no scanner on screen.
        // The dialog draws its contents a moment after it opens. A camera that
        // is quick to open (permission already given, a fast phone) can be
        // ready before the video element exists; wait for it briefly rather
        // than give up with the scanner showing a black box.
        let video = videoRef.current;
        for (let i = 0; !video && !stopped && i < 40; i++) {
          await new Promise((r) => setTimeout(r, 50));
          video = videoRef.current;
        }
        if (stopped || !video) {
          stream.getTracks().forEach((t) => t.stop());
          stream = null;
          return;
        }
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean; focusMode?: string[] };
        setTorchAvailable(Boolean(caps.torch));
        setTorchOn(false);
        // A web page gets only the camera behaviour it asks for. Left alone,
        // many phones hold one focus for the whole session, and a dense code
        // a hand's width away stays a blur: the phone's own camera app reads
        // the same code from the same distance because it keeps focusing.
        // Asked for where the camera says it can; ignored where it cannot.
        continuousFocus.current = false;
        if (track && caps.focusMode?.includes('continuous')) {
          try {
            await track.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] });
            continuousFocus.current = true;
          } catch {
            // Offered but refused: the scan goes on with whatever focus there is.
          }
        }
        video.srcObject = stream;
        await video.play();
        void tick();
      } catch (e) {
        setError(cameraProblem(e));
      }
    })();

    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
      trackRef.current = null;
    };
  }, [opened, attempt]);

  return (
    <Modal opened={opened} onClose={onClose} title="Scan a QR code" fullScreen padding="md">
      <Stack>
        {error ? (
          <Text c="red" size="sm">
            {error}
          </Text>
        ) : (
          <Text size="sm" c="dimmed">
            Hold the code steady and close to the camera. Dense generation codes need a moment.
          </Text>
        )}
        <video ref={videoRef} playsInline muted style={{ width: '100%', borderRadius: 'var(--v-radius-sm)', background: '#000' }} />
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
          {torchAvailable && (
            <Button variant="light" leftSection={torchOn ? <IconBulbOff size={16} stroke={1.8} /> : <IconBulb size={16} stroke={1.8} />} onClick={() => void toggleTorch()}>
              {torchOn ? 'Torch off' : 'Torch on'}
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
}

/** The browser's refusal, said in terms of what the person can do. */
function cameraProblem(e: unknown): string {
  const name = (e as { name?: string }).name ?? '';
  const message = (e as Error).message ?? String(e);
  if (name === 'NotAllowedError' || /denied/i.test(message)) {
    return "Camera access is blocked for this site. Allow it in the browser's site settings (the lock icon by the address, or the app's permissions on the phone), then try again, or paste the address instead.";
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Paste the address instead.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again, or paste the address instead.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not offer the camera to web apps here (it needs a secure https address). Paste the address instead.';
  return `Camera not available: ${message}. Paste the address instead.`;
}
