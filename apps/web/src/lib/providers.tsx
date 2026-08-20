'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider, TooltipProvider } from '@vims/ui';
import { useState, type ReactNode } from 'react';
import { ApiProblem } from '@/lib/api';
import { ToastRegion } from '@/lib/toast-region';

/**
 * Client-side data and feedback providers for the workspace.
 *
 * The retry policy is the part worth reading. A 4xx from this API is a decision,
 * not a hiccup: a 403 means the policy engine refused, a 409 means somebody else
 * edited the row, a 422 means a business rule said no. Retrying any of them
 * hides the answer behind three more identical refusals and, for a
 * reason-required action, writes three more denial rows into the audit log. Only
 * transport failures and 5xx are worth a second attempt.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // Admin data is read far more often than it changes, but "how long is a
        // stale role acceptable" has a real answer in EN-007 §5: permission
        // changes must take effect within 5 s. 30 s is the compromise for lists
        // that are not themselves the permission set; every mutation invalidates
        // its own keys immediately.
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        retry: (failureCount, error) => {
          if (error instanceof ApiProblem && error.status < 500) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function Providers({ children }: { readonly children: ReactNode }): React.JSX.Element {
  // Created once per browser session rather than at module scope: a module-level
  // client is shared across every request in a server render, which would mix
  // two users' caches.
  const [client] = useState(createQueryClient);

  return (
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={200}>
        <ToastProvider>
          {children}
          <ToastRegion label="Notifications" />
        </ToastProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}
