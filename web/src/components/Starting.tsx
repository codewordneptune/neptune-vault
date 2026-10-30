import { Logo } from './Logo';

/** The start of the app, drawn by index.html too until the page's code runs. */
export function Starting() {
  return (
    <div className="vault-starting" role="status" aria-label="Starting">
      <span className="vault-starting-glow">
        <Logo size={64} />
      </span>
    </div>
  );
}
