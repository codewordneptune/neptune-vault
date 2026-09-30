// Sentences the app says in more than one place, written once so they
// always read the same. One word per idea: a payment coming in and not yet
// in a block is Pending, a send reads Sending until a block confirms it,
// the change a pending send brings back is on hold, and only the wallet is
// locked.

/** After a send is handed to the node: what Sending means, and for how long. */
export const SENDING_UNTIL_CONFIRMED = 'It is final once a block confirms it, usually within an hour.';

/** A send the node took without answering, after "Your 0.1 NPT to Alice": what to do about it. */
export const MAY_HAVE_GONE_OUT = 'may have gone out, so do not send it again unless you first give up on it in History.';

/**
 * Under the title "Not sent": the reason, without saying again that nothing
 * was sent ("Nothing was sent: the node refused it" reads "The node refused it").
 */
export function notSentReason(message: string): string {
  const rest = message.replace(/^(not sent|nothing was sent)[:.]\s*/i, '');
  return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** When something on this device went wrong, but not with the coins. */
export const COINS_SAFE = 'Your coins are safe on the chain.';

/** Under Copy on the seed phrase: what copying it risks. */
export const CLIPBOARD_RISK = 'Other apps can read the clipboard: paste into a password manager, then clear it.';

/** Why installing the app is worth it. */
export const INSTALL_BENEFITS = 'An installed app keeps its storage, works full screen, and opens from its own icon.';

/** Beside a control that waits while a send runs. */
export const NOT_DURING_SEND = 'Not while a send is running.';

/** What a fast restore or rescan does, and what the node learns from it. */
export const FAST_SCAN = 'Usually takes seconds: only the blocks holding your payments are fetched. The node learns which payments are yours, including later ones to these addresses, but not the amounts.';
