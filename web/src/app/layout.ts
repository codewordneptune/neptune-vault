// The layout's widths, for the scripts, in px as global.css writes them: an
// em query moves with the browser's text size and a px one does not, so the
// two would switch at different widths.
//
// Up to 559 px is a phone held upright: a dialog rises from the foot as a
// sheet, Send leads with the amount, and the seed phrase is two columns.
// From 900 px, or a phone on its side, the tab bar is a rail at the side
// (global.css); a tablet between the two keeps the tab bar with the wide
// screen's dialogs and Send form. From 1100 px Settings shows its list and
// a page side by side.

import { useMediaQuery } from '@mantine/hooks';

export const PHONE = '(max-width: 559.98px)';
/** From 900 px, or a phone on its side: the rail, and the 720 px column. */
export const WIDE = '(min-width: 900px), (max-height: 500px) and (min-width: 560px) and (min-aspect-ratio: 16/10)';
export const SETTINGS_SPLIT = '(min-width: 1100px)';
/** Text large for the screen's width (an em here is the browser's text size): the header's Beta tag moves into the wallet menu (global.css). */
export const LARGE_TEXT = '(max-width: 19em)';

/** A field's section holding `icons` icon buttons: their targets, 4 px apart and 4 px clear of its sides. */
export const iconSection = (icons: number): string => `calc(${icons} * var(--v-tap) + ${icons + 1} * 4px)`;

/** Whether a query holds, read at once so a layout does not flash the other one first. */
export const useLayout = (query: string): boolean => useMediaQuery(query, undefined, { getInitialValueInEffect: false });
