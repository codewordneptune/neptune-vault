// Visual theme: the dark palette of useneptune.org (its main.css, data-theme
// dark) mapped onto Mantine's colour slots. Mantine reads text from dark[0],
// dimmed text from dark[2], borders from dark[4], panels and inputs from
// dark[6] and the page from dark[7].

import { createTheme, type MantineColorsTuple } from '@mantine/core';

const dark: MantineColorsTuple = [
  '#e4ebf4', // text
  '#c9d4e2',
  '#9aa9bc', // muted
  '#5f7390',
  '#314153', // line
  '#263243',
  '#1a2330', // panel
  '#111923', // body gradient start
  '#0d131c', // body gradient end
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
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontFamilyMonospace: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  defaultRadius: 'lg',
  headings: { fontWeight: '700' },
  components: {
    Paper: { defaultProps: { radius: 'lg', shadow: 'md' } },
    Button: { defaultProps: { radius: 'xl' } },
    Badge: { defaultProps: { radius: 'xl' } },
  },
});
