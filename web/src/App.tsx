import { Container, Stack, Text, Title } from '@mantine/core';
import { Route, Routes } from 'react-router-dom';

import { Diagnostics } from './screens/Diagnostics';

export function App() {
  return (
    <Container size="xs" py="md">
      <Stack gap="md">
        <Title order={2}>Neptune Vault</Title>
        <Routes>
          <Route path="/" element={<Diagnostics />} />
          <Route path="*" element={<Text c="dimmed">Not found</Text>} />
        </Routes>
      </Stack>
    </Container>
  );
}
