// Camera QR scanner for the recipient field. Uses the browser's barcode
// detector where it exists (Chrome on Android) and falls back to jsQR on
// video frames elsewhere (Safari). Generation addresses make a version-40
// code, so frames are captured at the camera's full resolution.

import { Button, Modal, Stack, Text } from '@mantine/core';
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
  const [error, setError] = useState<string | null>(null);

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
        video.srcObject = stream;
        await video.play();
        void tick();
      } catch (e) {
        setError(`Camera not available: ${(e as Error).message}. Allow camera access, or paste the address instead.`);
      }
    })();

    return () => {
      stopped = true;
      stream?.getTracks().forEach((t) => t.stop());
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
        <Button variant="default" onClick={onClose}>
          Cancel
        </Button>
      </Stack>
    </Modal>
  );
}
