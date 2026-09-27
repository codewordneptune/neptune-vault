// One copy pattern for the whole app: write to the clipboard and confirm
// with a short toast, so buttons keep their labels.

import { notifications } from '@mantine/notifications';

// `failed` says what to do instead, where a screen has something better to
// offer than trying again (Receive shows only a shortened address, so
// long-pressing the text there would copy something that is not an address).
export async function copyText(text: string, message = 'Copied', failed = 'Could not copy. Try again.'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    // Long enough to be read, or heard, before it goes.
    notifications.show({ message, color: 'green', autoClose: 4000 });
    return true;
  } catch {
    // What to do instead needs longer.
    notifications.show({ message: failed, color: 'red', autoClose: 10_000 });
    return false;
  }
}
