import type { ReactNode } from 'react';
import { DisplayRuntime } from '../../runtime/display-runtime';
import { RuntimeConfigProvider } from '../../runtime/runtime-config';

// A board must never be served from a build-time cache: the pairing state and
// the queue feed are both per-device and per-second.
export const dynamic = 'force-dynamic';

export default function DisplayPage(): ReactNode {
  return (
    <RuntimeConfigProvider>
      <DisplayRuntime />
    </RuntimeConfigProvider>
  );
}
