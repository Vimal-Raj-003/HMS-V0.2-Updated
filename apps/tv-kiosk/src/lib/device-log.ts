/**
 * `console.log` is banned repo-wide (CLAUDE.md §4) and a corridor TV has nobody
 * to read a console anyway. Device events go into a bounded ring buffer that the
 * hidden diagnostics card renders — the same list EN-018 §4 persists as
 * `display_device_events` once the fleet API exists.
 */
export type DeviceEventKind =
  | 'boot'
  | 'paired'
  | 'pairing_failed'
  | 'transport_started'
  | 'transport_switched'
  | 'snapshot'
  | 'reconnecting'
  | 'unauthorized'
  | 'error';

export interface DeviceEvent {
  readonly at: Date;
  readonly kind: DeviceEventKind;
  readonly detail: string;
}

export interface DeviceLog {
  record(kind: DeviceEventKind, detail: string): void;
  entries(): readonly DeviceEvent[];
}

export function createDeviceLog(now: () => Date, capacity = 50): DeviceLog {
  const buffer: DeviceEvent[] = [];
  return {
    record: (kind, detail) => {
      buffer.push({ at: now(), kind, detail });
      if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity);
    },
    entries: () => [...buffer].reverse(),
  };
}
