// Top-level error boundary: a rendering error shows a message and a Reload
// button instead of a blank page. Wallet data lives in IndexedDB and the
// worker, untouched by a render failure.

import { Button, Paper, Stack, Text, Title } from '@mantine/core';
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Neptune Vault crashed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ maxWidth: 540, margin: '48px auto', padding: '0 16px' }}>
        <Paper>
          <Stack>
            <Title order={2}>Something went wrong</Title>
            <Text size="sm" c="dimmed">
              The screen could not be drawn. Your wallet data is untouched: reloading brings the app back, and the phrase and backup file remain valid.
            </Text>
            <Text size="xs" c="dimmed" ff="monospace" style={{ wordBreak: 'break-word' }}>
              {this.state.error.message}
            </Text>
            <Button onClick={() => location.reload()}>Reload</Button>
          </Stack>
        </Paper>
      </div>
    );
  }
}
