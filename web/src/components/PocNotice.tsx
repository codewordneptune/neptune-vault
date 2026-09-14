// The proof-of-concept warning, on the first screens a person sees.

import { Alert, Text } from '@mantine/core';
import { IconAlertTriangle } from '@tabler/icons-react';

export function PocNotice() {
  return (
    <Alert color="orange" icon={<IconAlertTriangle size={18} />} title="Proof of concept, not for production use">
      <Text size="sm">No security audit, breaking changes ahead, and bugs may lose funds. Use it only with amounts you can afford to lose, and keep your phrase somewhere safe.</Text>
    </Alert>
  );
}
