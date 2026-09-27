// Sentences the app says in more than one place, written once so they
// always read the same. One word per idea: a payment not yet in a block is
// Pending, a send reads Sending until a block confirms it, coins waiting on
// a send are held, and only the wallet is locked.

/** After a send is handed to the node: what Sending means, and for how long. */
export const SENDING_UNTIL_CONFIRMED = 'It is final once a block confirms it, usually within an hour.';

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
