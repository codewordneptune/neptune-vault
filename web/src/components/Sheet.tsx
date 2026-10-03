import { Modal, type ModalProps } from '@mantine/core';

import { useBackCloses } from '../app/backCloses';

/** A dialog that Back closes, without leaving the screen under it (app/backCloses.ts). */
export function Sheet(props: ModalProps) {
  useBackCloses(props.opened, props.onClose);
  return <Modal {...props} />;
}
