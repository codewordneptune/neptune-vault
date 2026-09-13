// Visual theme: the dark palette of useneptune.org (its main.css, data-theme
// dark) mapped onto Mantine's colour slots. Mantine reads text from dark[0],
// dimmed text from dark[2], borders from dark[4], panels and inputs from
// dark[6] and the page from dark[7]. Sizes and radii form one scale, shared
// with global.css through CSS variables.

import { createTheme, type MantineColorsTuple } from '@mantine/core';

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
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, Roboto Mono, monospace',
  fontSizes: { xs: '0.75rem', sm: '0.875rem', md: '0.9375rem', lg: '1.0625rem', xl: '1.25rem' },
  // One radius scale: xs chips, sm controls, md cards, xl pills (badges only).
  defaultRadius: 'sm',
  radius: { xs: '8px', sm: '12px', md: '16px', lg: '20px', xl: '999px' },
  headings: {
    fontWeight: '600',
    sizes: {
      // h1 is the brand in the header; h2 a screen title; h3 a section label.
      h1: { fontSize: '0.9375rem', lineHeight: '1.2' },
      h2: { fontSize: '1.125rem' },
      h3: { fontSize: '0.8125rem' },
    },
  },
  components: {
    Paper: { defaultProps: { radius: 'md', shadow: 'none', p: 'lg', withBorder: false } },
    Button: { defaultProps: { radius: 'sm', size: 'md' } },
    Badge: { defaultProps: { radius: 'xl', variant: 'light', size: 'sm' } },
    TextInput: { defaultProps: { radius: 'sm', size: 'md' } },
    PasswordInput: { defaultProps: { radius: 'sm', size: 'md' } },
    NumberInput: { defaultProps: { radius: 'sm', size: 'md' } },
    Textarea: { defaultProps: { radius: 'sm', size: 'md' } },
    Select: { defaultProps: { radius: 'sm', size: 'md' } },
    SegmentedControl: { defaultProps: { radius: 'sm', size: 'sm' } },
    Alert: { defaultProps: { radius: 'sm', variant: 'light' } },
    Code: { defaultProps: { radius: 'sm' } },
    Menu: { defaultProps: { radius: 'sm', shadow: 'lg' } },
    Modal: { defaultProps: { radius: 'md', centered: true, overlayProps: { blur: 2 } } },
  },
});
