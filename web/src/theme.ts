// Visual theme: the dark palette of useneptune.org (its main.css, data-theme
// dark) mapped onto Mantine's colour slots. Mantine reads text from dark[0],
// dimmed text from dark[2], borders from dark[4], panels and inputs from
// dark[6] and the page from dark[7]. Sizes and radii form one scale, shared
// with global.css through CSS variables: four text sizes (12, 14, 16 and
// 20 px, plus the balance), two weights (400 and 600), three radii (8, 12
// and 16 px, plus pills), spacing on the steps global.css lists, and one
// black for text in the light palette.

import { createTheme, type MantineColorsTuple } from '@mantine/core';
import { IconCheck, IconChevronDown, IconEye, IconEyeOff, IconMinus, IconX } from '@tabler/icons-react';
import { createElement } from 'react';

// The library's own icons (the password toggle, the close cross, a select's
// arrow, a checkbox's tick) are the app's icons, at the app's weight. The
// tick is drawn heavier: at its 12 px a stroke of 2 is a hairline.
const PasswordToggleIcon = ({ reveal }: { reveal: boolean }) => createElement(reveal ? IconEyeOff : IconEye, { size: 20 });
const CheckboxTick = ({ indeterminate, className }: { indeterminate: boolean | undefined; className: string }) => createElement(indeterminate ? IconMinus : IconCheck, { className, stroke: 3 });

// A dropdown (a menu, a select's list) keeps clear of the sticky header and,
// on a phone, of the tab bar, safe areas included, and opens the other way
// when there is no room. Measured each time one is placed, so turning the
// phone or a larger text size counts.
const clearOfBars = {
  get top() {
    return (document.querySelector('.vault-topbar')?.getBoundingClientRect().bottom ?? 0) + 8;
  },
  get bottom() {
    // The tab bar along a phone's foot; on a wide screen it is a rail at the side.
    const bar = document.querySelector('.vault-tabbar')?.getBoundingClientRect();
    const atFoot = bar !== undefined && bar.width > bar.height && bar.bottom >= window.innerHeight - 1;
    return (atFoot ? window.innerHeight - bar.top : 0) + 8;
  },
};

const dark: MantineColorsTuple = [
  '#e4ebf4', // text
  '#c9d4e2',
  '#9aa9bc', // muted
  '#5f7390',
  '#2a3646', // line (only where Mantine insists on one)
  '#202b39',
  '#161f2b', // panel
  '#111923', // page
  '#0d131c',
  '#090e15',
];

// Accent blues: [5] is the site's --accent, [6] --accent-2, [7] --accent-deep.
const neptune: MantineColorsTuple = [
  '#eaf3ff',
  '#cfe3fb',
  '#a6cbf9',
  '#7db4f5',
  '#5ea3f7',
  '#3a8bf3',
  '#1f6fe0',
  '#1a5fc4',
  '#144c9f',
  '#0f3a7a',
];

export const theme = createTheme({
  colors: { dark, neptune },
  primaryColor: 'neptune',
  primaryShade: { light: 6, dark: 6 },
  // The system's own face everywhere: nothing is bundled, so a named web font
  // (Inter led the stack) only ever showed where someone had installed it.
  fontFamily: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  // The one monospace stack; global.css reads it as --mantine-font-family-monospace.
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSizes: { xs: '0.75rem', sm: '0.875rem', md: '1rem', lg: '1.25rem', xl: '1.25rem' },
  // Spacing on the declared steps (global.css): the library's xl was 32 px.
  spacing: { xs: '0.625rem', sm: '0.75rem', md: '1rem', lg: '1.25rem', xl: '1.5rem' },
  // The light palette's text, the tokens' own, not pure black.
  black: '#15202e',
  // One radius scale: xs chips, sm controls, md cards, xl pills (badges only).
  defaultRadius: 'sm',
  radius: { xs: '8px', sm: '12px', md: '16px', lg: '16px', xl: '999px' },
  headings: {
    fontWeight: '600',
    sizes: {
      // h1 is the brand in the header; h2 a screen title. An h3 is sized in
      // global.css: a section label in a card, or a prose heading on Privacy.
      h1: { fontSize: '1rem', lineHeight: '1.2' },
      h2: { fontSize: '1.25rem' },
    },
  },
  components: {
    Paper: { defaultProps: { radius: 'md', shadow: 'none', p: 'lg', withBorder: false } },
    Button: { defaultProps: { radius: 'sm', size: 'md' } },
    Badge: { defaultProps: { radius: 'xl', variant: 'light', size: 'sm' } },
    TextInput: { defaultProps: { radius: 'sm', size: 'md' } },
    // The show and hide button is reached with Tab like any other: a keyboard
    // user checks what they typed as anyone else does.
    PasswordInput: { defaultProps: { radius: 'sm', size: 'md', visibilityToggleFocusable: true, visibilityToggleIcon: PasswordToggleIcon, visibilityToggleButtonProps: { size: 'lg', className: 'vault-tap', 'aria-label': 'Show or hide the password' } } },
    NumberInput: { defaultProps: { radius: 'sm', size: 'md' } },
    Textarea: { defaultProps: { radius: 'sm', size: 'md' } },
    Select: { defaultProps: { radius: 'sm', size: 'md', rightSection: createElement(IconChevronDown, { size: 16 }) } },
    SegmentedControl: { defaultProps: { radius: 'sm', size: 'md' } },
    // Square, so a checkbox never reads as a radio button.
    Checkbox: { defaultProps: { radius: 'xs', icon: CheckboxTick } },
    Alert: { defaultProps: { radius: 'sm', variant: 'light' } },
    // Every close button has a name: a banner's or a toast's said only
    // "button". A dialog's own ("Close") and a notice's still win.
    CloseButton: { defaultProps: { 'aria-label': 'Dismiss', icon: createElement(IconX) } },
    Code: { defaultProps: { radius: 'sm' } },
    // Opening a menu focuses its first item, as the ARIA menu pattern has it,
    // not an empty placeholder; that placeholder was also an element a menu
    // may not hold among its items. A chosen item shows the app's tick.
    Menu: { defaultProps: { radius: 'sm', shadow: 'lg', withInitialFocusPlaceholder: false, checkIcon: createElement(IconCheck, { size: 16 }) } },
    // Menus and selects place their dropdowns through Popover.
    Popover: { defaultProps: { middlewares: { flip: { padding: clearOfBars }, shift: true } } },
    // A dialog's header is a <header>, which outside an article or a section
    // is a page banner: every open dialog would give the page a second one.
    // It is only a row holding the title and the close button, so it says so.
    Modal: { defaultProps: { radius: 'md', centered: true, overlayProps: { blur: 2 }, closeButtonProps: { 'aria-label': 'Close' }, attributes: { header: { role: 'none' } } } },
    Drawer: { defaultProps: { closeButtonProps: { 'aria-label': 'Close' }, attributes: { header: { role: 'none' } } } },
  },
});
