// Camera QR scanner for the recipient field. Uses the browser's barcode
// detector where it exists (Chrome on Android) and falls back to jsQR on
// video frames elsewhere (Safari). Generation addresses make a version-40
// code, so frames are captured at the camera's full resolution.

import { Button, Group, Modal, Stack, Text } from '@mantine/core';
import { IconBulb, IconBulbOff } from '@tabler/icons-react';
import jsQR from 'jsqr';
import { useEffect, useRef, useState } from 'react';

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
  const [torchAvailable, setTorchAvailable] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const toggleTorch = async () => {
    const track = trackRef.current;
    if (!track) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torchOn } as MediaTrackConstraintSet] });
      setTorchOn((v) => !v);
    } catch {
      setTorchAvailable(false);
    }
  };

  useEffect(() => {
    if (!opened) return;
    let stream: MediaStream | null = null;
    let stopped = false;
    const canvas = document.createElement('canvas');
    const detector = window.BarcodeDetector ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;

    const finish = (text: string) => {
      if (stopped) return;
      stopped = true;
      onResult(text);
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
            const code = jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' });
            if (code?.data) return finish(code.data);
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
        if (stopped) return;
        const video = videoRef.current;
        if (!video) return;
        const track = stream.getVideoTracks()[0] ?? null;
        trackRef.current = track;
        const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorchAvailable(Boolean(caps.torch));
        setTorchOn(false);
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
  }, [opened, onResult]);

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
    return 'Camera access is blocked for this site. Allow it in the browser\x27s site settings (the lock icon by the address, or the app\x27s permissions on the phone), then try again, or paste the address instead.';
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No camera was found on this device. Paste the address instead.';
  if (name === 'NotReadableError') return 'The camera is in use by another app. Close it and try again, or paste the address instead.';
  if (!navigator.mediaDevices?.getUserMedia) return 'This browser does not offer the camera to web apps here (it needs a secure https address). Paste the address instead.';
  return `Camera not available: ${message}. Paste the address instead.`;
}
