// A QR code shown as large as the screen allows, for someone else's camera.
//
// A Standard address makes a code so dense that it sits at the edge of what
// a phone camera resolves, and there a fifth more size can be what makes it
// read. The view is white whatever the theme: the white around the code is
// the quiet border a scanner needs. The screen is kept awake while it is
// open, since a phone that dims or locks while someone lines up a camera is
// how showing a code goes wrong in practice. Brightness is the person's to
// raise: a web page is given no way to.

import { Modal, Stack, Text } from '@mantine/core';

import { useScreenWakeLock } from '../app/wakeLock';

export function QrFullScreen({
  src,
  opened,
  onClose,
  title,
  subtitle,
  caption,
}: {
  src: string;
  opened: boolean;
  onClose: () => void;
  title: string;
  /** A second, quieter line under the title: the address's technical name. */
  subtitle?: string;
  caption: string;
}) {
  useScreenWakeLock(opened);

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      fullScreen
      title={
        // Spans, not a stack: the title sits inside a heading.
        <>
          <span className="vault-qr-full-title">{title}</span>
          {subtitle && <span className="vault-qr-full-subtitle">{subtitle}</span>}
        </>
      }
      padding="md"
      classNames={{ content: 'vault-qr-full', header: 'vault-qr-full-header', body: 'vault-qr-full-body' }}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <Stack align="center" gap="sm">
        {/* A tap on the code closes the view, as a tap opened it. */}
        <button type="button" className="vault-qr-full-code" onClick={onClose} aria-label="Close the full screen code">
          <img src={src} alt={subtitle ? `${title}, ${subtitle}` : title} />
        </button>
        {/* 16 px: read at arm's length and compared character by character, and a monospace face looks smaller than its size. */}
        <Text fz="1rem" ta="center" className="vault-qr-full-caption">
          {caption}
        </Text>
        <Text size="sm" ta="center" className="vault-qr-full-hint">
          Turn the screen brightness up if the code will not read.
        </Text>
      </Stack>
    </Modal>
  );
}
