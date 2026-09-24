// Three tiers of notice, told apart by form and not only by colour:
//
// - a banner (Mantine's Alert, red) when something went wrong: a send that
//   failed, an error. At most one on a screen.
// - a caution (this Caution): an amber strip down the left edge, an icon, no
//   fill. For what deserves care before acting: an unaudited app, a missing
//   backup, a public announcement, an address that shows every payment.
// - information (this Info): plain text with an icon, in the page's own
//   colours. For what helps but asks nothing.
//
// The result of something the person just did (a file exported, a password
// changed, a send submitted) is a Done: information with a check, announced,
// placed right under the control that caused it. Events that happen on
// their own (a payment arriving, a send finishing on another screen) are
// toasts; errors from a form sit under the form's button.

import { CloseButton } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-react';
import type { HTMLAttributes, ReactNode } from 'react';

type NoticeProps = {
  title?: ReactNode;
  children?: ReactNode;
  /** Replaces the default icon. */
  icon?: ReactNode;
  /** Shows a close button that calls this. */
  onClose?: () => void;
  closeLabel?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, 'title'>;

const ICONS = {
  caution: <IconAlertTriangle size={18} stroke={1.8} />,
  info: <IconInfoCircle size={18} stroke={1.8} />,
  done: <IconCircleCheck size={18} stroke={1.8} />,
};

function Notice({ tier, title, children, icon, onClose, closeLabel, className, ...rest }: NoticeProps & { tier: 'caution' | 'info' | 'done' }) {
  return (
    <div className={`vault-notice vault-${tier}${className ? ' ' + className : ''}`} {...rest}>
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
            onClose();
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
  return <Notice tier="done" role="status" {...props} />;
}
