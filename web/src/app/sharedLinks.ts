// Payments that reach the app from elsewhere without the neptunecash: scheme:
// text shared into the installed web app from another app (the manifest's
// share_target opens /share), and /pay web links, which carry a payment
// request after the # so that it never reaches the server. Each becomes the
// text Send reads, as a scanned code is; nothing is sent until the person
// reviews it.

import { parsePaymentText } from '../util/address';

/** The payment request in a /pay web link, or null when it is not one. */
export function fromPayLink(text: string): string | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.pathname.replace(/\/+$/, '') !== '/pay') return null;
  return requestInFragment(url.hash);
}

/** The payment request after a link's #, as written: an app that encoded its colon still counts. */
export function requestInFragment(hash: string): string | null {
  const fragment = hash.replace(/^#/, '').replace(/^neptunecash%3a/i, 'neptunecash:');
  return /^neptunecash:/i.test(fragment) ? fragment : null;
}

// A payment request by its scheme, or an address of a kind the app knows by its prefix.
const PAYMENT_LIKE = /^(?:(?:neptunecash|npt):|(?:nolga|nech|nview|nolsym)[a-z]*1[0-9a-z]{20,}$)/i;

/**
 * What Send should read from shared text: the first piece of it that reads as
 * an address or a payment request (a message often holds other words and
 * punctuation around it), a /pay link's request, or else all of it, for Send
 * to say why it does not read.
 */
export function paymentTextIn(shared: string): string {
  const pieces = shared
    .split(/\s+/)
    .map((piece) => piece.replace(/^[("'<[]+|[)"'>\].,;:!?]+$/g, ''))
    .filter(Boolean)
    .map((piece) => fromPayLink(piece) ?? piece);
  return pieces.find((piece) => PAYMENT_LIKE.test(piece) && !parsePaymentText(piece).error) ?? shared.trim();
}
