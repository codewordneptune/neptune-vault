// The bar a browser or an installed app draws above the page takes the
// header's colour, in the app's own theme and not only the device's, so the
// two read as one surface. index.html says the same for the first paint.

import { useComputedColorScheme } from '@mantine/core';
import { useEffect } from 'react';

export function useThemeColor(): void {
  const scheme = useComputedColorScheme();
  useEffect(() => {
    const colour = getComputedStyle(document.documentElement).getPropertyValue('--v-page').trim();
    if (!colour) return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', colour);
  }, [scheme]);
}
