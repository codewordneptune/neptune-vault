// A link that turns on Developer networks: the app's address with
// ?developer. Before a wallet exists there is no Settings screen to find the
// switch in, so this is how a developer or tester on a new device gets the
// network choice in setup.

import type { Services } from './services';

/** The address without ?developer when it has it, else null. */
export function withoutDeveloperFlag(href: string): string | null {
  const url = new URL(href);
  if (!url.searchParams.has('developer')) return null;
  url.searchParams.delete('developer');
  return url.toString();
}

/** Turns Developer networks on when the page was opened with ?developer, and takes it out of the address. */
export async function applyDeveloperLink(services: Services): Promise<void> {
  const rest = withoutDeveloperFlag(window.location.href);
  if (rest === null) return;
  // Once: a reload or a bookmark made now does not carry it.
  window.history.replaceState(window.history.state, '', rest);
  if (services.settings.developerNetworks !== true) await services.updateSettings({ developerNetworks: true });
}
