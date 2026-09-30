// The privacy statement: a page of Settings, reached from About (its title
// and way back come from there), and a screen of its own before a wallet
// exists, reached from setup, with a way back.

import { Paper, Stack, Text, Title, UnstyledButton } from '@mantine/core';
import { IconChevronLeft } from '@tabler/icons-react';
import { useNavigate } from 'react-router-dom';

import { PRIVACY, PRIVACY_UPDATED } from '../content/privacy';
import { formatDate } from '../util/time';

/** The statement itself, for a page that gives it a title. */
export function PrivacyStatement() {
  return (
    <Paper>
      <Stack>
        <Text size="sm" c="dimmed">
          What this wallet keeps, what it sends and to whom, and what is public. Last changed {formatDate(Date.parse(`${PRIVACY_UPDATED}T12:00:00`))}.
        </Text>
        {PRIVACY.map((section) => (
          <Stack key={section.title} gap="xs">
            <Title order={3} className="vault-prose-heading">
              {section.title}
            </Title>
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

/** On its own, before a wallet exists: the way back, then the title, as Settings' pages have them. */
export function Privacy() {
  return (
    <Stack gap="md">
      <BackLink />
      <Title order={2}>Privacy</Title>
      <PrivacyStatement />
    </Stack>
  );
}

/** "‹ Back", in the same place and form as a Settings page's way back. */
export function BackLink() {
  const navigate = useNavigate();
  return (
    <UnstyledButton onClick={() => navigate(-1)} c="var(--v-accent-text)" fz="sm" className="vault-tap-link vault-tap-link-start vault-back-link">
      <IconChevronLeft size={16} stroke={1.8} aria-hidden />
      Back
    </UnstyledButton>
  );
}
