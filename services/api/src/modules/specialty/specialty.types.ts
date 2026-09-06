import type { ConsoleTab } from '@vims/contracts';

/** Row shapes the console shell, the worklist and the investigations pane read. */

export interface ConsoleRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly moduleKey: string;
  readonly departmentIds: readonly string[];
  readonly tabs: readonly ConsoleTab[];
  readonly worklistConfig: Record<string, unknown>;
  readonly billingLinks: Record<string, unknown>;
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface DeviceTypeRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly consoleId: string;
  readonly transport: string;
  readonly mimeTypes: readonly string[];
  readonly parserKey: string | null;
  readonly reportTemplateKey: string | null;
  readonly billingServiceCode: string | null;
  readonly reviewDueHours: number;
  readonly sideRequired: boolean;
  readonly active: boolean;
}

export interface ConsoleDetail {
  readonly console: ConsoleRow;
  readonly deviceTypes: readonly DeviceTypeRow[];
}

export interface DeviceOrderRow {
  readonly id: string;
  readonly patientId: string;
  readonly encounterId: string;
  readonly consoleCode: string;
  readonly deviceResultTypeCode: string;
  readonly deviceResultTypeName: string | null;
  readonly side: string;
  readonly status: string;
  readonly orderedAt: string;
  readonly orderedBy: string;
  readonly performedAt: string | null;
  readonly attachedAt: string | null;
  readonly resultFileId: string | null;
  readonly pacsStudyUid: string | null;
  readonly parsed: unknown;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly cancelReason: string | null;
  readonly chargeIntentId: string | null;
  /**
   * Minutes an attached result has gone unlooked-at, and whether that is past
   * the type's own window. The rail is sorted on this.
   */
  readonly minutesUnreviewed: number | null;
  readonly reviewOverdue: boolean;
}

export interface StageRow {
  readonly id: string;
  readonly encounterId: string;
  readonly patientId: string;
  readonly consoleCode: string;
  readonly stageKey: string;
  readonly queueDefinitionId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number;
  readonly open: boolean;
}

/**
 * One patient on a console's worklist.
 *
 * `pendingResults` and `unreviewedResults` are separate on purpose: a patient
 * waiting on a scan that has not been done is a scheduling problem, and one
 * whose scan is sitting unlooked-at is a clinical one. A single "results"
 * count hides whichever is the smaller number that day.
 */
export interface WorklistRow {
  readonly encounterId: string;
  readonly patientId: string;
  readonly patientName: string;
  readonly uhid: string;
  readonly stageKey: string | null;
  readonly stageStartedAt: string | null;
  readonly minutesInStage: number | null;
  readonly tokenDisplay: string | null;
  readonly pendingResults: number;
  readonly unreviewedResults: number;
}
