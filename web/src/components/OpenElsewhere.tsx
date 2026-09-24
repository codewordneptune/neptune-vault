// Shown in a window that is not the one holding the wallet.

import { Button, Center, Stack, Text, Title } from '@mantine/core';
import { useState } from 'react';

import type { WindowOwner } from '../app/windowOwner';

export function OpenElsewhere({ owner, onHere }: { owner: WindowOwner; onHere: () => void }) {
  const [asking, setAsking] = useState(false);
  const [refused, setRefused] = useState(false);

  const useHere = async () => {
    setAsking(true);
    setRefused(false);
    const result = await owner.takeOver();
    setAsking(false);
    if (result === 'owner') onHere();
    else setRefused(true);
  };

  return (
    <Center mih="100dvh" p="md">
      <Stack align="center" gap="md" maw={420} ta="center">
        <Title order={2}>Neptune Vault is open in another window</Title>
        <Text c="dimmed">
          Using the wallet here locks it in the other window. Only one window can use it at a time, so they never overwrite each other.
        </Text>
        {refused && (
          <Text c="var(--v-danger-text)" role="alert">
            The other window is in the middle of a send, and a send is not interrupted. Try again when it has finished.
          </Text>
        )}
        <Button onClick={() => void useHere()} loading={asking}>
          Use here
        </Button>
      </Stack>
    </Center>
  );
}
