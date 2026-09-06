/** The shapes the console shell, the worklist and the investigations pane read. */

export interface ConsoleTab {
  readonly key: string;
  readonly label: string;
  readonly component?: string;
  readonly formTemplateKey?: string;
  readonly roles?: readonly string[];
}

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
  readonly transport: string;
  readonly parserKey: string | null;
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
  readonly performedAt: string | null;
  readonly attachedAt: string | null;
  readonly pacsStudyUid: string | null;
  readonly parsed: unknown;
  readonly reviewedAt: string | null;
  readonly reviewedBy: string | null;
  readonly cancelReason: string | null;
  readonly chargeIntentId: string | null;
  readonly minutesUnreviewed: number | null;
  readonly reviewOverdue: boolean;
}

export interface StageRow {
  readonly id: string;
  readonly encounterId: string;
  readonly stageKey: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly minutes: number;
  readonly open: boolean;
}

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
