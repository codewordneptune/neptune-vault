// Three tiers of notice, told apart by form and not only by colour, and
// one error pattern:
//
// - an error line (ErrorLine) when something went wrong: red text under the
//   control that failed, with a title and a close when it outlives the
//   moment (a send that failed). No red panels.
// - a caution (this Caution): an amber strip down the left edge, an icon, no
//   fill. For what deserves care before acting: an unaudited app, a missing
//   backup, a public announcement, an address that shows every payment.
// - information (this Info): plain text with an icon, in the page's own
//   colours. For what helps but asks nothing.
// - advice (NoticeLine): one line in the calm blue with its main action,
//   the reason and the rest behind a chevron. For what asks little and
//   can wait (backing up a browser wallet, installing the app).
//
// Standing on the page between cards (Home's), a notice or an error line
// is a card of its own, edged in its colour (global.css); inside a card or
// a sheet it keeps the form above.
//
// The result of something the person just did (a file exported, a password
// changed, a send submitted) is a Done: information with a check, announced,
// placed right under the control that caused it. Events that happen on
// their own (a payment arriving, a send finishing on another screen) are
// toasts; errors from a form sit under the form's button.

import { ActionIcon, CloseButton } from '@mantine/core';
import { IconAlertTriangle, IconChevronRight, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import { useEffect, useId, useRef, useState, type HTMLAttributes, type ReactNode } from 'react';

type NoticeProps = {
  title?: ReactNode;
  children?: ReactNode;
  /** Replaces the default icon. */
  icon?: ReactNode;
  /** Shows a close button that calls this. */
  onClose?: () => void;
  closeLabel?: string;
  /**
   * Take the focus when it appears, so it is read out as focus arrives: for
   * the result of something just done. A live region created together with
   * its text is often not announced at all.
   */
  focusOnMount?: boolean;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>;

/**
 * Where focus goes when a notice closes itself: the heading of the card it
 * was in, or of the screen. The close button is gone with it.
 */
export function headingNear(from: HTMLElement): HTMLElement | null {
  const heading = from.closest('.mantine-Paper-root')?.querySelector<HTMLElement>('h2, h3') ?? document.querySelector<HTMLElement>('main h2');
  if (heading && !heading.hasAttribute('tabindex')) heading.tabIndex = -1;
  return heading;
}

const ICONS = {
  caution: <IconAlertTriangle size={20} />,
  info: <IconInfoCircle size={20} />,
  done: <IconCircleCheck size={20} />,
};

function Notice({ tier, title, children, icon, onClose, closeLabel, className, focusOnMount, ...rest }: NoticeProps & { tier: 'caution' | 'info' | 'done' }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusOnMount) return;
    // After a dialog that led here has closed and handed focus back.
    const t = setTimeout(() => root.current?.focus(), 300);
    return () => clearTimeout(t);
  }, [focusOnMount]);
  return (
    <div ref={root} tabIndex={focusOnMount ? -1 : undefined} className={`vault-notice vault-${tier}${className ? ' ' + className : ''}`} {...rest}>
      <span className="vault-notice-icon" aria-hidden>
        {icon ?? ICONS[tier]}
      </span>
      <div className="vault-notice-body">
        {title && <div className="vault-notice-title">{title}</div>}
        {children && <div className="vault-notice-text">{children}</div>}
      </div>
      {onClose && (
        <CloseButton
          size="sm"
          className="vault-notice-close"
          aria-label={closeLabel ?? 'Dismiss'}
          onClick={(e) => {
            e.stopPropagation();
            const heading = headingNear(e.currentTarget);
            onClose();
            heading?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

/**
 * What went wrong with what was just tried: red text right under the
 * control, announced as it appears unless the caller says otherwise.
 */
export function ErrorLine({ title, children, onClose, closeLabel, className, role = 'alert', ...rest }: Omit<NoticeProps, 'icon' | 'focusOnMount'>) {
  return (
    <div role={role} className={`vault-error-line${className ? ' ' + className : ''}`} {...rest}>
      <div className="vault-notice-body">
        {title && <div className="vault-error-title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
      {onClose && (
        <CloseButton
          size="sm"
          className="vault-notice-close"
          aria-label={closeLabel ?? 'Dismiss'}
          onClick={(e) => {
            e.stopPropagation();
            const heading = headingNear(e.currentTarget);
            onClose();
            heading?.focus({ preventScroll: true });
          }}
        />
      )}
    </div>
  );
}

export function Caution(props: NoticeProps) {
  return <Notice tier="caution" {...props} />;
}

export function Info(props: NoticeProps) {
  return <Notice tier="info" {...props} />;
}

/** The result of an action, announced; see the rules at the top. */
export function Done(props: NoticeProps) {
  // One that takes the focus is read out as it does; a live region as well would say it twice.
  return <Notice tier="done" role={props.focusOnMount ? undefined : 'status'} {...props} />;
}

/**
 * Advice in one line, a card on the page: an icon, what it is about, its
 * main action, and a chevron that opens the reason and whatever else it
 * offers (a second action, dismissing it). `about` names it for the
 * chevron's label, as in "More about the storage warning".
 */
export function NoticeLine({ title, action, about, children }: { title: ReactNode; action?: ReactNode; about: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const moreId = useId();
  return (
    <div className="vault-noticeline">
      <div className="vault-noticeline-row">
        <span className="vault-noticeline-icon" aria-hidden>
          <IconInfoCircle size={20} />
        </span>
        <span className="vault-noticeline-title">{title}</span>
        {action}
        {children && (
          <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-expanded={open} aria-controls={moreId} aria-label={(open ? 'Less about ' : 'More about ') + about} onClick={() => setOpen((v) => !v)}>
            <IconChevronRight size={20} className={open ? 'vault-chevron open' : 'vault-chevron'} />
          </ActionIcon>
        )}
      </div>
      {children && open && (
        <div id={moreId} className="vault-noticeline-more">
          {children}
        </div>
      )}
    </div>
  );
}
