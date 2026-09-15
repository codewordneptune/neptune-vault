// The privacy statement, a sub-screen reached from About in Settings.

import { ActionIcon, Paper, Stack, Text, Title } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

import { PRIVACY, PRIVACY_UPDATED } from '../content/privacy';

export function Privacy() {
  const navigate = useNavigate();
  return (
    <Paper>
      <Stack>
        <div className="vault-title-row">
          <ActionIcon variant="subtle" size="lg" className="vault-tap" aria-label="Back" onClick={() => navigate(-1)}>
            <IconChevronLeft size={22} stroke={1.8} />
          </ActionIcon>
          <Title order={2}>Privacy</Title>
        </div>
        <Text size="sm" c="dimmed">
          What this wallet keeps, what it sends and to whom, and what is public. Last changed {new Date(PRIVACY_UPDATED).toLocaleDateString()}.
        </Text>
        {PRIVACY.map((section) => (
          <Stack key={section.title} gap="xs">
            <Title order={3}>{section.title}</Title>
            {section.paragraphs.map((p, i) => (
              <Text key={i} size="sm">
                {p}
              </Text>
            ))}
          </Stack>
        ))}
      </Stack>
    </Paper>
  );
}
