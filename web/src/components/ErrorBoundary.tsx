// Top-level error boundary: a rendering error shows a message and a Reload
// button instead of a blank page. Wallet data lives in IndexedDB and the
// worker, untouched by a render failure.

import { Component, type ErrorInfo, type ReactNode } from 'react';

import { FailureScreen } from './FailureScreen';

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
      <FailureScreen
        title="Something went wrong"
        said="Something went wrong showing this screen. Your wallet is safe: reload to continue. Your seed phrase and backup files are not affected."
        error={this.state.error.message}
      />
    );
  }
}
