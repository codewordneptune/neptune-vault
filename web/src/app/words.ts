// Sentences the app says in more than one place, written once so they
// always read the same. One word per idea: a payment coming in and not yet
// in a block is Pending; a send is being prepared while this device makes
// it, and is sent, waiting for a block, once the node has it; the change a
// pending send brings back is on hold; and only the wallet is locked.

/** A send this device is still making: nothing has left the wallet. */
export const PREPARING_SEND = 'Preparing your send';

/** A send the node has, until a block confirms it. */
export const SENT_WAITING = 'Sent, waiting for a block';

/** The same, as History says it beside a send's time. */
export const WAITING_FOR_BLOCK = 'Waiting for a block';

/** Each step of preparing a send, in the same words on Send and in the strip under the header. */
export function sendStageText(stage: string, onSend = false): string {
  switch (stage) {
    case 'planning':
      return 'Choosing coins';
    case 'membership-proofs':
      return 'Checking your coins with the node';
    case 'building':
      return 'Building the send';
    case 'proving':
      return 'Proving';
    case 'confirming':
      return onSend ? 'Ready: confirm it' : 'Ready: confirm it on Send';
    case 'submitting':
      return 'Submitting to the node';
    case 'done':
      return SENT_WAITING;
    default:
      return stage;
  }
}

/** After a send is handed to the node: when it is final. */
export const SENDING_UNTIL_CONFIRMED = 'It is final once a block confirms it, usually within an hour.';

/** A send the node took without answering, after "Your 0.1 NPT to Alice": what to do about it. */
export const MAY_HAVE_GONE_OUT = 'may have gone out. Before you send it again, wait until History shows it as Sent or Not sent.';

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
