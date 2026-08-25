/**
 * `integration.lab_instruments` and `integration.lab_instrument_test_maps`,
 * read through the hub's tenant-scoped client.
 *
 * `connection` is JSONB because, as the schema comment says, "every driver needs
 * a different subset and a column per field would be forty mostly-null columns".
 * That flexibility is only safe if something validates it, so it is parsed with
 * Zod at the boundary and the rest of this service sees a typed
 * `AnalyzerConnection`. An instrument whose connection block is malformed fails
 * here — at start-up, in front of the engineer configuring it — rather than at
 * 03:00 when a result arrives and a field reads `undefined`.
 *
 * `numeric` columns come back from `pg` as strings, deliberately (an IEEE double
 * cannot hold every `numeric(18,8)`). `unit_factor` is converted once, here,
 * because a factor that silently became `NaN` would turn 5.4 mmol/L into a
 * result nobody can interpret.
 */
import { z } from 'zod';
import type { IntegrationDatabase, TenantContext, TransactionClient } from '../db/database.js';
import type {
  AnalyzerConnection,
  AnalyzerInstrument,
  InstrumentTestMap,
  LabIfProtocol,
  LabIfTransport,
  LabInstrumentStatus,
} from './types.js';

export const analyzerConnectionSchema = z
  .object({
    host: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    sendingApplication: z.string().min(1).max(64).default('VIMSHMS'),
    sendingFacility: z.string().min(1).max(64).default('VIMS'),
    receivingApplication: z.string().min(1).max(64).default('ANALYZER'),
    receivingFacility: z.string().min(1).max(64).default('LAB'),
    hl7Version: z.string().min(1).max(16).default('2.5.1'),
    specimenIdFields: z.array(z.string().min(3).max(16)).min(1).max(8).optional(),
    controlSpecimenPattern: z.string().min(1).max(200).optional(),
    maxFrameBytes: z.number().int().min(1024).max(16_777_216).optional(),
  })
  .strip();

export class AnalyzerConfigError extends Error {
  constructor(
    readonly instrumentCode: string,
    readonly issues: readonly string[],
  ) {
    super(
      `instrument '${instrumentCode}' has an unusable connection block:\n${issues.map((i) => `  ${i}`).join('\n')}`,
    );
    this.name = 'AnalyzerConfigError';
  }
}

export function parseAnalyzerConnection(code: string, value: unknown): AnalyzerConnection {
  const parsed = analyzerConnectionSchema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new AnalyzerConfigError(
      code,
      parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an
  // absent key from one holding `undefined`, and Zod produces the latter.
  const c = parsed.data;
  return {
    ...(c.host === undefined ? {} : { host: c.host }),
    ...(c.port === undefined ? {} : { port: c.port }),
    sendingApplication: c.sendingApplication,
    sendingFacility: c.sendingFacility,
    receivingApplication: c.receivingApplication,
    receivingFacility: c.receivingFacility,
    hl7Version: c.hl7Version,
    ...(c.specimenIdFields === undefined ? {} : { specimenIdFields: c.specimenIdFields }),
    ...(c.controlSpecimenPattern === undefined ? {} : { controlSpecimenPattern: c.controlSpecimenPattern }),
    ...(c.maxFrameBytes === undefined ? {} : { maxFrameBytes: c.maxFrameBytes }),
  };
}

interface InstrumentRow {
  id: string;
  hospital_id: string;
  branch_id: string;
  code: string;
  name: string;
  driver_key: string;
  protocol: LabIfProtocol;
  transport: LabIfTransport;
  connection: unknown;
  host_query_mode: boolean;
  send_demographics: boolean;
  status: LabInstrumentStatus;
  raw_retention_days: number;
  is_buffering: boolean;
}

interface TestMapRow {
  id: string;
  instrument_id: string;
  instrument_code: string;
  instrument_sample_type_code: string | null;
  test_key: string;
  parameter_key: string | null;
  loinc_code: string | null;
  unit_factor: string | null;
  unit_offset: string | null;
  target_unit: string | null;
  precision: number | null;
  result_type: string;
  flag_map: unknown;
  is_active: boolean;
}

const INSTRUMENT_COLUMNS = `id, hospital_id, branch_id, code, name, driver_key, protocol, transport,
  connection, host_query_mode, send_demographics, status, raw_retention_days, is_buffering`;

function toInstrument(row: InstrumentRow): AnalyzerInstrument {
  return {
    id: row.id,
    hospitalId: row.hospital_id,
    branchId: row.branch_id,
    code: row.code,
    name: row.name,
    driverKey: row.driver_key,
    protocol: row.protocol,
    transport: row.transport,
    connection: parseAnalyzerConnection(row.code, row.connection),
    hostQueryMode: row.host_query_mode,
    sendDemographics: row.send_demographics,
    status: row.status,
    rawRetentionDays: row.raw_retention_days,
    isBuffering: row.is_buffering,
  };
}

function toNumber(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toFlagMap(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null;
  const out: Record<string, string> = {};
  for (const [key, mapped] of Object.entries(value as Record<string, unknown>)) {
    if (typeof mapped === 'string') out[key.toUpperCase()] = mapped;
  }
  return Object.keys(out).length === 0 ? null : out;
}

function toTestMap(row: TestMapRow): InstrumentTestMap {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    instrumentCode: row.instrument_code,
    instrumentSampleTypeCode: row.instrument_sample_type_code,
    testKey: row.test_key,
    parameterKey: row.parameter_key,
    loincCode: row.loinc_code,
    unitFactor: toNumber(row.unit_factor),
    unitOffset: toNumber(row.unit_offset),
    targetUnit: row.target_unit,
    precision: row.precision,
    resultType: row.result_type,
    flagMap: toFlagMap(row.flag_map),
    isActive: row.is_active,
  };
}

export class InstrumentStore {
  constructor(private readonly db: IntegrationDatabase) {}

  async get(ctx: TenantContext, instrumentId: string): Promise<AnalyzerInstrument | undefined> {
    return this.db.withTenant(ctx, async (tx) => {
      const row = await tx.maybeOne<InstrumentRow>(
        `SELECT ${INSTRUMENT_COLUMNS} FROM integration.lab_instruments WHERE id = $1`,
        [instrumentId],
      );
      return row === undefined ? undefined : toInstrument(row);
    });
  }

  async byCode(ctx: TenantContext, code: string): Promise<AnalyzerInstrument | undefined> {
    return this.db.withTenant(ctx, async (tx) => {
      const row = await tx.maybeOne<InstrumentRow>(
        `SELECT ${INSTRUMENT_COLUMNS} FROM integration.lab_instruments WHERE code = $1 LIMIT 1`,
        [code],
      );
      return row === undefined ? undefined : toInstrument(row);
    });
  }

  /**
   * Instruments whose listener this process should run.
   *
   * `EN-004 §5`: "Only `live` instruments receive orders/produce patient
   * results; `verification` instruments write to sandbox worklists." Both are
   * listened to — a commissioning engineer needs the socket up — and it is the
   * ingress that refuses to apply a patient result from anything but `live`.
   */
  async listenable(ctx: TenantContext): Promise<readonly AnalyzerInstrument[]> {
    return this.db.withTenant(ctx, async (tx) => {
      const rows = await tx.rows<InstrumentRow>(
        `SELECT ${INSTRUMENT_COLUMNS}
           FROM integration.lab_instruments
          WHERE status IN ('live', 'verification')
            AND transport IN ('tcp_server', 'tcp_client')
          ORDER BY code`,
      );
      return rows.map(toInstrument);
    });
  }

  async testMaps(ctx: TenantContext, instrumentId: string): Promise<readonly InstrumentTestMap[]> {
    return this.db.withTenant(ctx, (tx) => this.testMapsIn(tx, instrumentId));
  }

  async testMapsIn(tx: TransactionClient, instrumentId: string): Promise<readonly InstrumentTestMap[]> {
    const rows = await tx.rows<TestMapRow>(
      `SELECT id, instrument_id, instrument_code, instrument_sample_type_code, test_key, parameter_key,
              loinc_code, unit_factor::text AS unit_factor, unit_offset::text AS unit_offset,
              target_unit, precision, result_type, flag_map, is_active
         FROM integration.lab_instrument_test_maps
        WHERE instrument_id = $1`,
      [instrumentId],
    );
    return rows.map(toTestMap);
  }

  /**
   * `EN-004 §3.7.1`: an instrument that has gone quiet buffers rather than
   * drops. The flag is a projection for the health board — the buffering itself
   * is a property of `lab_if_messages.status`, not of this column, so a crash
   * between the two cannot lose a frame.
   */
  async setBuffering(ctx: TenantContext, instrumentId: string, buffering: boolean, at: Date): Promise<void> {
    await this.db.withTenant(ctx, async (tx) => {
      await tx.query(
        `UPDATE integration.lab_instruments
            SET is_buffering = $2,
                buffered_since = CASE WHEN $2 THEN COALESCE(buffered_since, $3) ELSE NULL END,
                buffered_count = CASE WHEN $2 THEN buffered_count ELSE 0 END,
                updated_at = $3
          WHERE id = $1`,
        [instrumentId, buffering, at],
      );
    });
  }

  async countBuffered(ctx: TenantContext, instrumentId: string, count: number, at: Date): Promise<void> {
    await this.db.withTenant(ctx, async (tx) => {
      await tx.query(
        `UPDATE integration.lab_instruments
            SET buffered_count = $2, updated_at = $3
          WHERE id = $1`,
        [instrumentId, count, at],
      );
    });
  }

  async heartbeat(ctx: TenantContext, instrumentId: string, at: Date): Promise<void> {
    await this.db.withTenant(ctx, async (tx) => {
      await tx.query(
        `UPDATE integration.lab_instruments SET last_heartbeat_at = $2, updated_at = $2 WHERE id = $1`,
        [instrumentId, at],
      );
    });
  }
}
