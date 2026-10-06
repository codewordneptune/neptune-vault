import { Modal, type ModalProps } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { IconChevronLeft } from '@tabler/icons-react';
import { useRef, type PointerEvent } from 'react';

import { useBackCloses } from '../app/backCloses';

/** How far down a sheet is swiped before it closes, or how far and how fast for a flick; a tap that wobbles does not count. */
const CLOSE_AFTER_PX = 96;
const FLICK_AFTER_PX = 32;
const CLOSE_FASTER_THAN = 0.6; // px per ms

/**
 * A dialog that Back closes, without leaving the screen under it
 * (app/backCloses.ts). On a phone it rises from the bottom, where the
 * thumb is, with a handle at its top: a swipe down from there closes it.
 * One asked to fill the screen (the scanner, a code shown full size) does
 * that instead, and a wider screen keeps a dialog in the middle.
 *
 * Closing one that is a step of a task (Send's review) goes back a step:
 * `back` names that step, at the header's start in place of the cross.
 */
export function Sheet({ back, ...given }: ModalProps & { back?: string }) {
  useBackCloses(given.opened, given.onClose);
  const phone = useMediaQuery('(max-width: 36em)', undefined, { getInitialValueInEffect: false });
  const drag = useRef<{ y: number; at: number; sheet: HTMLElement; pointer: number } | null>(null);
  const props: ModalProps = !back
    ? given
    : {
        ...given,
        className: [given.className, 'vault-sheet-backed'].filter(Boolean).join(' '),
        closeButtonProps: { ...given.closeButtonProps, icon: <IconChevronLeft size={16} />, children: back, 'aria-label': back, className: 'vault-sheet-back' },
      };
  if (!phone || props.fullScreen) return <Modal {...props} />;

  const down = (e: PointerEvent<HTMLElement>) => {
    // The close button keeps its own tap.
    if ((e.target as HTMLElement).closest('button')) return;
    const sheet = e.currentTarget.closest<HTMLElement>('.vault-sheet');
    if (!sheet) return;
    drag.current = { y: e.clientY, at: performance.now(), sheet, pointer: e.pointerId };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer already gone: the drag ends at its next event.
    }
    sheet.style.transition = 'none';
  };
  const move = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    d.sheet.style.transform = `translateY(${Math.max(0, e.clientY - d.y)}px)`;
  };
  const up = (e: PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointer !== e.pointerId) return;
    drag.current = null;
    const dy = Math.max(0, e.clientY - d.y);
    d.sheet.style.transition = '';
    d.sheet.style.transform = '';
    const flick = dy > FLICK_AFTER_PX && dy / Math.max(16, performance.now() - d.at) > CLOSE_FASTER_THAN;
    if (dy > CLOSE_AFTER_PX || flick) props.onClose();
  };

  const named: Record<string, string | undefined> = typeof props.classNames === 'object' && props.classNames ? (props.classNames as Record<string, string | undefined>) : {};
  const join = (part: string, own: string) => [own, named[part]].filter(Boolean).join(' ');
  return (
    <Modal
      {...props}
      centered={false}
      size="100%"
      classNames={{ ...named, inner: join('inner', 'vault-sheet-inner'), content: join('content', 'vault-sheet'), header: join('header', 'vault-sheet-header') }}
      transitionProps={{ transition: 'slide-up', duration: 220, ...props.transitionProps }}
      attributes={{ header: { role: 'none', onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up } }}
    />
  );
}
