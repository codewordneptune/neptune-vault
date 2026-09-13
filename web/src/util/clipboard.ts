// One copy pattern for the whole app: write to the clipboard and confirm
// with a short toast, so buttons keep their labels.

import { notifications } from '@mantine/notifications';

export async function copyText(text: string, message = 'Copied'): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    notifications.show({ message, color: 'green', autoClose: 1500 });
    return true;
  } catch {
    notifications.show({ message: 'Could not copy. Long-press the text to copy it.', color: 'red' });
    return false;
  }
}
