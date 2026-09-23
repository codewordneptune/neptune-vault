// What the native shell does for the app around the wallet: the things a
// web view cannot do well by itself.

import { call } from './bridge';

/**
 * Offers the system's Save dialog for `contents`, suggesting
 * `suggestedName`, and writes the file where the person chooses. The shell
 * opens the dialog itself, so the page never names a path. Resolves to the
 * path saved to, or null when the person cancelled.
 */
export function saveFile(suggestedName: string, contents: string): Promise<string | null> {
  return call<string | null>('app_save_file', { suggestedName, contents });
}

/** Opens one of the project's pages in the system's browser; the shell refuses any other. */
export function openUrl(url: string): Promise<void> {
  return call<void>('app_open_url', { url });
}
