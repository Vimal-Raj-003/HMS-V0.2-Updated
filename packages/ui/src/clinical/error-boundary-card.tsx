'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Button } from '../primitives/button.js';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '../primitives/card.js';

/**
 * `ErrorBoundaryCard` — docs/06 §5.2 #38: "Contained failure with error reference id,
 * 'Retry', 'Copy diagnostics', 'Report to IT' (creates NC-028 ticket). Never blanks the
 * screen; never leaks a stack trace or PHI."
 *
 * The stack is deliberately never rendered and never copied: `copyDiagnostics` hands the
 * caller only the reference id, the error *name* and the component stack's first frame,
 * because a React error message can contain rendered patient data (docs/04 §5).
 */
export interface ErrorBoundaryCardLabels {
  readonly title: string;
  readonly body: string;
  readonly referencePrefix: string;
  readonly retry: string;
  readonly copyDiagnostics: string;
  readonly reportToIt: string;
}

export interface ErrorDiagnostics {
  readonly reference: string;
  readonly errorName: string;
  readonly componentName: string;
}

export interface ErrorBoundaryCardProps {
  readonly children: ReactNode;
  readonly labels: ErrorBoundaryCardLabels;
  /** Correlation id from the request context; shown to the user and quoted to IT. */
  readonly reference: string;
  readonly onRetry?: () => void;
  readonly onReport?: (diagnostics: ErrorDiagnostics) => void;
  readonly onCopyDiagnostics?: (diagnostics: ErrorDiagnostics) => void;
  readonly className?: string;
}

interface ErrorBoundaryCardState {
  readonly error: Error | null;
  readonly componentName: string;
}

export class ErrorBoundaryCard extends Component<ErrorBoundaryCardProps, ErrorBoundaryCardState> {
  override state: ErrorBoundaryCardState = { error: null, componentName: 'unknown' };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryCardState> {
    return { error };
  }

  override componentDidCatch(_error: Error, info: ErrorInfo): void {
    // Only the first frame, and only the component name — never the stack, never props.
    const firstFrame = (info.componentStack ?? '').trim().split('\n')[0] ?? '';
    const match = /at\s+([A-Za-z0-9_$.]+)/.exec(firstFrame);
    this.setState({ componentName: match?.[1] ?? 'unknown' });
  }

  private diagnostics(): ErrorDiagnostics {
    return {
      reference: this.props.reference,
      errorName: this.state.error?.name ?? 'Error',
      componentName: this.state.componentName,
    };
  }

  private readonly handleRetry = (): void => {
    this.setState({ error: null, componentName: 'unknown' });
    this.props.onRetry?.();
  };

  override render(): ReactNode {
    const { children, labels, className, onReport, onCopyDiagnostics } = this.props;
    if (this.state.error === null) {
      return children;
    }

    return (
      <Card
        data-slot="error-boundary-card"
        role="alert"
        className={cn('border-danger-border', className)}
      >
        <CardHeader>
          <CardTitle className="text-danger-fg">{labels.title}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          <p className="text-md text-fg-default">{labels.body}</p>
          <p className="font-mono text-sm text-fg-muted">
            {labels.referencePrefix} {this.props.reference}
          </p>
        </CardContent>
        <CardFooter>
          <Button variant="primary" size="sm" onClick={this.handleRetry}>
            {labels.retry}
          </Button>
          {onCopyDiagnostics === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onCopyDiagnostics(this.diagnostics());
              }}
            >
              {labels.copyDiagnostics}
            </Button>
          )}
          {onReport === undefined ? null : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                onReport(this.diagnostics());
              }}
            >
              {labels.reportToIt}
            </Button>
          )}
        </CardFooter>
      </Card>
    );
  }
}
