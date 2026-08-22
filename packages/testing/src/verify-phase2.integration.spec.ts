import type { Pool } from 'pg';
import { runSeed } from '@vims/db/seed';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestPostgres, type TestPostgres } from './containers/postgres.js';
import { asTenant, withRollback, type TenantClient } from './fixtures/database.js';

/**
 * Phase 2 exit gates 2, 3 and 4 — driven against a real PostgreSQL.
 *
 *   gate 2  "Prescribe a drug the patient is allergic to → hard stop; prove in a
 *            test that no configuration flag can disable it."
 *   gate 3  "A missing weight blocks paediatric dosing."
 *   gate 4  "Amend a signed note → new version, old version intact, reason
 *            captured, audit chain valid."
 *
 * plus the two structural rules `phase-02` §2.7 and EN-029 §5 state in the same
 * breath: every override is coded, and a medico-legal record is never destroyed.
 *
 * These live in `@vims/testing` and not in `packages/db` because `packages/db`
 * cannot import the harness without making the workspace graph cyclic — the
 * harness already depends on `@vims/db` for the seed and the tenancy helpers.
 *
 * Three rules this file follows, each of which was learned by getting it wrong:
 *
 *  1. **Assert the refusal, not the happy path.** A guard that exists proves
 *     nothing about what it refuses. Every invariant here is driven by a
 *     statement that must fail, and `refuses()` fails the test loudly when the
 *     database *accepts* it — which is exactly what happens the day somebody
 *     drops the trigger.
 *
 *  2. **Assert both directions.** A test that only proves a floor rule cannot be
 *     disabled would pass just as well on a table where nothing can be disabled
 *     at all. So each lock is paired with a control that must succeed: the
 *     tunable rule disables, the amended document version is written, the
 *     ordinary destruction run is approved.
 *
 *  3. **The tenant context must be complete.** Setting `app.hospital_id` without
 *     `app.branch_ids` makes the generated policy's branch arm
 *     (`branch_id IS NULL OR branch_id = ANY (core.current_branch_ids())`) match
 *     nothing: every query returns zero rows, every assertion passes vacuously,
 *     and the suite looks green. `tenantContextIsComplete()` below is the guard
 *     against that, and it is asserted before anything else is read as
 *     `hms_app`.
 */

/** The eight columns `clinical.cdss_safety_floor` has, and the only eight it may have. */
const SAFETY_FLOOR_COLUMNS = [
  'authority',
  'condition',
  'countersign_role',
  'degrades_offline',
  'family',
  'key',
  'rationale',
  'sort_order',
] as const;

/** The six floor families, verbatim from `docs/04 §7` by way of the migration's seed. */
const SAFETY_FLOOR_KEYS = [
  'allergy_documented_anaphylaxis',
  'dose_above_absolute_ceiling',
  'interaction_contraindicated',
  'ndps_statutory_cap',
  'paediatric_missing_weight',
  'pregnancy_category_x',
] as const;

/**
 * Any name a switch is given. Kept in step with the regex the migration itself
 * asserts on (`§C.6`), so the two fail together rather than drifting apart.
 */
const SWITCH_COLUMN_NAMES =
  /^(active|enabled|disabled|is_active|is_enabled|suspended|status|state|effective_to|valid_to|expires_at|disabled_at|retired_at|suppressed|suppression|override_allowed|bypass|waiver)$/;

const TENANT_KEY_COLUMN_NAMES = new Set(['hospital_id', 'branch_id', 'group_id', 'org_id']);

interface Fixture {
  readonly hospitalId: string;
  readonly branchIds: readonly string[];
  readonly patientId: string;
  /** Three distinct people: a proposer and two approvers (NC-003 §5). */
  readonly userA: string;
  readonly userB: string;
  readonly userC: string;
  readonly overrideReasonId: string;
  readonly overrideReasonCode: string;
  /** A published version of a rule that enforces NO floor — the tunable case. */
  readonly tunableRuleVersionId: string;
}

describe('Phase 2 — the clinical hard stops have nothing to switch off', () => {
  let pg: TestPostgres;
  let db: Pool;
  let fx: Fixture;

  beforeAll(async () => {
    pg = await startTestPostgres();
    db = pg.pool('migrator');
    // 'demo' is the smallest tier that seeds the CDSS rule estate and the
    // override-reason master these assertions read.
    await runSeed(db, 'demo');
    fx = await loadFixture(db);
  }, 600_000);

  afterAll(async () => {
    await pg?.stop();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. The allergy hard stop has no off switch.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('the safety floor', () => {
    it('carries no column that could mean "off", and none that could scope it to a tenant', async () => {
      // Read from `information_schema` rather than from a hand-written list of
      // "columns we know about": this fails the day somebody ADDS one, which is
      // the only failure mode worth catching. The migration asserts the same
      // thing at apply time; this is the assertion that survives into CI.
      const { rows } = await db.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = 'clinical' AND table_name = 'cdss_safety_floor'
          ORDER BY column_name`,
      );

      expect(rows.length, 'clinical.cdss_safety_floor was not found at all').toBeGreaterThan(0);

      const names = rows.map((r) => r.column_name);
      expect(names).toStrictEqual([...SAFETY_FLOOR_COLUMNS]);

      const switches = names.filter((n) => SWITCH_COLUMN_NAMES.test(n));
      expect(
        switches,
        'A product-level hard stop acquired a column that could turn it off (docs/04 §7).',
      ).toStrictEqual([]);

      const tenantKeys = names.filter((n) => TENANT_KEY_COLUMN_NAMES.has(n));
      expect(tenantKeys, 'A per-hospital floor is not a floor (docs/04 §7).').toStrictEqual([]);

      // `degrades_offline` is the one documentation boolean the migration
      // permits, and D-9 pins it to false by CHECK. Any other boolean is a flag.
      const booleans = rows.filter((r) => r.data_type === 'boolean').map((r) => r.column_name);
      expect(booleans).toStrictEqual(['degrades_offline']);
    });

    it('grants hms_app SELECT and nothing else, so the rows cannot be removed either', async () => {
      const { rows } = await db.query<{
        can_select: boolean;
        can_insert: boolean;
        can_update: boolean;
        can_delete: boolean;
      }>(
        `SELECT has_table_privilege('hms_app', 'clinical.cdss_safety_floor', 'SELECT') AS can_select,
                has_table_privilege('hms_app', 'clinical.cdss_safety_floor', 'INSERT') AS can_insert,
                has_table_privilege('hms_app', 'clinical.cdss_safety_floor', 'UPDATE') AS can_update,
                has_table_privilege('hms_app', 'clinical.cdss_safety_floor', 'DELETE') AS can_delete`,
      );

      // Readable: an unreadable safety floor is a safety floor that does not fire.
      expect(rows[0]?.can_select).toBe(true);
      expect(rows[0]?.can_insert).toBe(false);
      expect(rows[0]?.can_update).toBe(false);
      expect(rows[0]?.can_delete).toBe(false);
    });

    it('refuses the application role at runtime, not only on paper', async () => {
      await asTenant(pg, tenantContext(fx), async (app) => {
        await assertTenantContextIsComplete(app, fx);

        await refuses(
          app,
          /permission denied for table cdss_safety_floor/,
          `INSERT INTO clinical.cdss_safety_floor (key, family, condition, rationale, authority)
           VALUES ('local_override', 'allergy', 'anything', 'because we said so', 'nobody')`,
        );
        await refuses(
          app,
          /permission denied for table cdss_safety_floor/,
          `UPDATE clinical.cdss_safety_floor SET degrades_offline = true
            WHERE key = 'allergy_documented_anaphylaxis'`,
        );
        await refuses(
          app,
          /permission denied for table cdss_safety_floor/,
          `DELETE FROM clinical.cdss_safety_floor WHERE key = 'allergy_documented_anaphylaxis'`,
        );
      });
    });

    it('presents all six floor families to a tenant session, none of them degradable', async () => {
      await asTenant(pg, tenantContext(fx), async (app) => {
        await assertTenantContextIsComplete(app, fx);

        const rows = await app.rows<{
          key: string;
          family: string;
          countersign_role: string | null;
          degrades_offline: boolean;
        }>(
          `SELECT key, family::text AS family, countersign_role, degrades_offline
             FROM clinical.cdss_safety_floor ORDER BY key`,
        );

        expect(rows.map((r) => r.key)).toStrictEqual([...SAFETY_FLOOR_KEYS]);
        // D-9, read straight off the table: not one family degrades when the
        // vendor knowledge base is unavailable.
        expect(rows.every((r) => r.degrades_offline === false)).toBe(true);
        // The allergy family may be acknowledged with a consultant's
        // countersignature; §5 below proves the countersignature is enforced.
        const allergy = rows.find((r) => r.key === 'allergy_documented_anaphylaxis');
        expect(allergy?.countersign_role).toBe('consultant');
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. A floor rule cannot be neutralised as if it were an ordinary rule.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('a rule that declares enforces_floor_key', () => {
    /**
     * Both fixtures are asserted into the state the test needs *before* the
     * test acts, because a rule that arrived already disabled would make the
     * "cannot be disabled" assertion meaningless and the "can be disabled"
     * assertion pass for free.
     */
    const rulesFor = async (
      client: TenantClient,
    ): Promise<{ floorRuleId: string; floorKey: string; tunableRuleId: string }> => {
      const [floor] = await client.rows<{ id: string; enforces_floor_key: string }>(
        `SELECT id, enforces_floor_key FROM clinical.cdss_rules
          WHERE hospital_id = $1 AND key = 'allergy.documented.hard_stop'
            AND status = 'active' AND enforces_floor_key IS NOT NULL AND disabled_at IS NULL`,
        [fx.hospitalId],
      );
      const [tunable] = await client.rows<{ id: string }>(
        `SELECT id FROM clinical.cdss_rules
          WHERE hospital_id = $1 AND key = 'ddi.major.soft_stop'
            AND status = 'active' AND enforces_floor_key IS NULL AND disabled_at IS NULL`,
        [fx.hospitalId],
      );
      if (floor === undefined || tunable === undefined) {
        throw new Error(
          'fixture: the demo seed no longer provides an active floor-enforcing rule and an active tunable rule side by side',
        );
      }
      return {
        floorRuleId: floor.id,
        floorKey: floor.enforces_floor_key,
        tunableRuleId: tunable.id,
      };
    };

    it('cannot be disabled, shadowed, retired or emergency-disabled', async () => {
      await withRollback(db, async (client) => {
        const { floorRuleId } = await rulesFor(client);

        for (const status of ['disabled', 'shadow', 'retired'] as const) {
          await refuses(
            client,
            /enforces safety floor .* and cannot be set to/,
            `UPDATE clinical.cdss_rules
                SET status = $2, disabled_at = now(), disabled_by = $3, disabled_reason = 'too noisy'
              WHERE id = $1`,
            [floorRuleId, status, fx.userA],
          );
        }

        // EN-029 §3.4.5's emergency disable is for tunable rules only, and it is
        // refused here even while the status stays `active` — otherwise a rule
        // could be silenced without ever looking disabled.
        await refuses(
          client,
          /cannot be emergency-disabled/,
          `UPDATE clinical.cdss_rules
              SET disabled_at = now(), disabled_by = $2, disabled_reason = 'incident 4471'
            WHERE id = $1`,
          [floorRuleId, fx.userA],
        );
      });
    });

    it('cannot be downgraded below hard_stop, suppressed, or end-dated', async () => {
      await withRollback(db, async (client) => {
        const { floorRuleId } = await rulesFor(client);
        const nextVersion = await nextRuleVersion(client, floorRuleId);
        const approvalRef = fx.userA;

        await refuses(
          client,
          /must be hard_stop, not soft_stop/,
          `INSERT INTO clinical.cdss_rule_versions
             (id, hospital_id, rule_id, version, family, condition, action, interruption,
              approval_ref, effective_from, checksum)
           VALUES (gen_random_uuid(), $1, $2, $3, 'allergy', '{}', '{}', 'soft_stop', $4, now(), $5)`,
          [fx.hospitalId, floorRuleId, nextVersion, approvalRef, hex64('a')],
        );

        // EN-029 §5: "Suppression never applies to hard-stops or critical values."
        await refuses(
          client,
          /may carry no suppression policy/,
          `INSERT INTO clinical.cdss_rule_versions
             (id, hospital_id, rule_id, version, family, condition, action, interruption,
              suppression, approval_ref, effective_from, checksum)
           VALUES (gen_random_uuid(), $1, $2, $3, 'allergy', '{}', '{}', 'hard_stop',
                   '{"window_hours": 72}', $4, now(), $5)`,
          [fx.hospitalId, floorRuleId, nextVersion, approvalRef, hex64('b')],
        );

        // An end date is a switch with a calendar attached.
        await refuses(
          client,
          /may not be given an end date/,
          `INSERT INTO clinical.cdss_rule_versions
             (id, hospital_id, rule_id, version, family, condition, action, interruption,
              approval_ref, effective_from, effective_to, checksum)
           VALUES (gen_random_uuid(), $1, $2, $3, 'allergy', '{}', '{}', 'hard_stop',
                   $4, now(), now() + interval '30 days', $5)`,
          [fx.hospitalId, floorRuleId, nextVersion, approvalRef, hex64('c')],
        );

        // The control: a properly approved hard_stop version publishes normally.
        // Without this, every assertion above would also hold on a table that
        // rejected every insert.
        await client.query(
          `INSERT INTO clinical.cdss_rule_versions
             (id, hospital_id, rule_id, version, family, condition, action, interruption,
              approval_ref, effective_from, checksum)
           VALUES (gen_random_uuid(), $1, $2, $3, 'allergy', '{}', '{}', 'hard_stop', $4, now(), $5)`,
          [fx.hospitalId, floorRuleId, nextVersion, approvalRef, hex64('d')],
        );
        const published = await client.scalar<string>(
          `SELECT interruption::text FROM clinical.cdss_rule_versions
            WHERE rule_id = $1 AND version = $2`,
          [floorRuleId, nextVersion],
        );
        expect(published).toBe('hard_stop');
      });
    });

    it('leaves an ordinary rule fully tunable — the lock is on the floor, not on the table', async () => {
      await withRollback(db, async (client) => {
        const { tunableRuleId } = await rulesFor(client);

        // `ddi.major.soft_stop` is what alert-fatigue governance exists to tune.
        // If this failed, the "cannot be disabled" assertions above would be
        // proving nothing more than that the table is read-only.
        await client.query(
          `UPDATE clinical.cdss_rules
              SET status = 'disabled', disabled_at = now(), disabled_by = $2,
                  disabled_reason = 'override rate 61%, governance minute GC-2026-08'
            WHERE id = $1`,
          [tunableRuleId, fx.userA],
        );

        const status = await client.scalar<string>(
          `SELECT status::text FROM clinical.cdss_rules WHERE id = $1`,
          [tunableRuleId],
        );
        expect(status).toBe('disabled');
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. A finalised clinical note cannot be rewritten. (exit gate 4)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('a finalised clinical document', () => {
    /** A document with exactly one signed version. Returns both ids. */
    const signedNote = async (
      client: TenantClient,
    ): Promise<{ documentId: string; versionId: string; sha1: string }> => {
      const [doc] = await client.rows<{ id: string }>(
        `INSERT INTO clinical.documents
           (id, hospital_id, branch_id, patient_id, type, title, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'consult_note', 'OPD consultation note', now())
         RETURNING id`,
        [fx.hospitalId, fx.branchIds[0], fx.patientId],
      );
      if (doc === undefined) throw new Error('fixture: the document was not created');

      const [version] = await client.rows<{ id: string; content_sha256: string }>(
        `INSERT INTO clinical.document_versions
           (id, hospital_id, document_id, version, status, content, content_sha256,
            signed_by, signed_at, sign_method)
         VALUES (gen_random_uuid(), $1, $2, 1, 'final', $3::jsonb, $4, $5, now(), 'system')
         RETURNING id, content_sha256`,
        [
          fx.hospitalId,
          doc.id,
          JSON.stringify({ impression: 'Right ankle sprain, grade II' }),
          // The seal trigger overwrites this from the content; supplying a
          // deliberately wrong-but-shaped digest is how we prove it does.
          hex64('f'),
          fx.userA,
        ],
      );
      if (version === undefined) throw new Error('fixture: the version was not created');
      return { documentId: doc.id, versionId: version.id, sha1: version.content_sha256 };
    };

    it('computes its own digest rather than trusting the one it was handed', async () => {
      await withRollback(db, async (client) => {
        const { sha1 } = await signedNote(client);
        expect(sha1).not.toBe(hex64('f'));
        expect(sha1).toMatch(/^[0-9a-f]{64}$/);
      });
    });

    it('refuses an UPDATE that touches content, hash or signature after draft', async () => {
      await withRollback(db, async (client) => {
        const { versionId } = await signedNote(client);

        await refuses(
          client,
          /is final and immutable/,
          `UPDATE clinical.document_versions SET content = '{"impression":"tampered"}'::jsonb WHERE id = $1`,
          [versionId],
        );
        await refuses(
          client,
          /is final and immutable/,
          `UPDATE clinical.document_versions SET content_sha256 = $2 WHERE id = $1`,
          [versionId, hex64('e')],
        );
        await refuses(
          client,
          /is final and immutable/,
          `UPDATE clinical.document_versions SET signed_by = $2, signed_at = now() WHERE id = $1`,
          [versionId, fx.userB],
        );
        await refuses(
          client,
          /is final and immutable/,
          `UPDATE clinical.document_versions SET amendment_reason = 'retrofitted' WHERE id = $1`,
          [versionId],
        );

        // The one UPDATE the guard permits, so that "immutable" is proven to be
        // narrower than "frozen": stamping the supersession pointer.
        await client.query(
          `UPDATE clinical.document_versions
              SET superseded_by_version = 2, superseded_at = now(), status = 'amended'
            WHERE id = $1`,
          [versionId],
        );
        const status = await client.scalar<string>(
          `SELECT status::text FROM clinical.document_versions WHERE id = $1`,
          [versionId],
        );
        expect(status).toBe('amended');
      });
    });

    it('refuses DELETE outright', async () => {
      await withRollback(db, async (client) => {
        const { versionId } = await signedNote(client);
        // Refused for the schema owner by the trigger; §D additionally revokes
        // DELETE from `hms_app`, so the application has nothing to bypass with.
        await refuses(client, /is append-only/, `DELETE FROM clinical.document_versions WHERE id = $1`, [
          versionId,
        ]);
      });
    });

    it('refuses an amendment with no reason, accepts one with a reason, and leaves v1 intact', async () => {
      await withRollback(db, async (client) => {
        const { documentId } = await signedNote(client);

        await refuses(
          client,
          /document_versions_amendment_reason/,
          `INSERT INTO clinical.document_versions
             (id, hospital_id, document_id, version, status, content, content_sha256,
              signed_by, signed_at, sign_method)
           VALUES (gen_random_uuid(), $1, $2, 2, 'final', $3::jsonb, $4, $5, now(), 'system')`,
          [
            fx.hospitalId,
            documentId,
            JSON.stringify({ impression: 'Right ankle sprain, grade III' }),
            hex64('0'),
            fx.userA,
          ],
        );

        await client.query(
          `INSERT INTO clinical.document_versions
             (id, hospital_id, document_id, version, status, content, content_sha256,
              amendment_reason, signed_by, signed_at, sign_method)
           VALUES (gen_random_uuid(), $1, $2, 2, 'final', $3::jsonb, $4,
                   'Grade corrected after the MRI report', $5, now(), 'system')`,
          [
            fx.hospitalId,
            documentId,
            JSON.stringify({ impression: 'Right ankle sprain, grade III' }),
            hex64('0'),
            fx.userA,
          ],
        );

        const versions = await client.rows<{ version: number; impression: string }>(
          `SELECT version, content->>'impression' AS impression
             FROM clinical.document_versions WHERE document_id = $1 ORDER BY version`,
          [documentId],
        );
        expect(versions).toStrictEqual([
          { version: 1, impression: 'Right ankle sprain, grade II' },
          { version: 2, impression: 'Right ankle sprain, grade III' },
        ]);

        // `clinical.documents` is a projection the database maintains, not one
        // the caller is trusted to keep in step.
        const head = await client.rows<{ current_version: number; current_status: string }>(
          `SELECT current_version, current_status::text AS current_status
             FROM clinical.documents WHERE id = $1`,
          [documentId],
        );
        expect(head[0]).toStrictEqual({ current_version: 2, current_status: 'final' });

        // The chain, recomputed from scratch by the database: every digest still
        // describes its own content, and every link still points at the version
        // before it.
        const chain = await client.rows<{
          version: number;
          hash_matches: boolean;
          link_matches: boolean;
        }>(`SELECT version, hash_matches, link_matches FROM clinical.verify_document_chain($1)`, [
          documentId,
        ]);
        expect(chain).toStrictEqual([
          { version: 1, hash_matches: true, link_matches: true },
          { version: 2, hash_matches: true, link_matches: true },
        ]);
      });
    });

    it('refuses a version that claims a predecessor it does not have', async () => {
      await withRollback(db, async (client) => {
        const { documentId } = await signedNote(client);
        // Version 3 with no version 2 would leave a hole the chain verifier
        // could not see, because `lag()` would happily link 3 to 1.
        await refuses(
          client,
          /has no version 2 to chain to/,
          `INSERT INTO clinical.document_versions
             (id, hospital_id, document_id, version, status, content, content_sha256,
              amendment_reason, signed_by, signed_at, sign_method)
           VALUES (gen_random_uuid(), $1, $2, 3, 'final', '{"impression":"skipped"}'::jsonb, $3,
                   'Skipping a version', $4, now(), 'system')`,
          [fx.hospitalId, documentId, hex64('0'), fx.userA],
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. A paediatric dose cannot use a weight nobody recorded. (exit gate 3)
  // ═══════════════════════════════════════════════════════════════════════════
  describe('the dosing weight', () => {
    const insertEncounter = (columns: string, values: string): string =>
      `INSERT INTO clinical.encounters
         (id, hospital_id, branch_id, patient_id, visit_id, type, status, started_at, updated_at${columns})
       VALUES (gen_random_uuid(), $1, $2, $3, gen_random_uuid(), 'opd', 'in_progress', now(), now()${values})`;

    it('refuses a source of "measured" with no weight', async () => {
      await withRollback(db, async (client) => {
        // The dangerous shape: an `IS NOT NULL` check written against the source
        // column would wave this straight through.
        //
        // The attribution columns are supplied deliberately. Leaving them out
        // would also be refused — by `encounters_dosing_weight_attributed` —
        // and the test would then pass with the pairing constraint dropped.
        await refuses(
          client,
          /encounters_dosing_weight_unknown_pairing/,
          insertEncounter(
            `, dosing_weight_source, dosing_weight_at, dosing_weight_by, dosing_weight_vitals_id`,
            `, 'measured', now(), $4, gen_random_uuid()`,
          ),
          [fx.hospitalId, fx.branchIds[0], fx.patientId, fx.userA],
        );
      });
    });

    it('refuses a weight of zero', async () => {
      await withRollback(db, async (client) => {
        // Zero kilograms is not a patient. Making it unrepresentable is what
        // makes NULL mean exactly one thing: nobody weighed them.
        await refuses(
          client,
          /encounters_dosing_weight_plausible/,
          insertEncounter(
            `, dosing_weight_kg, dosing_weight_source, dosing_weight_at, dosing_weight_by, dosing_weight_vitals_id`,
            `, 0, 'measured', now(), $4, gen_random_uuid()`,
          ),
          [fx.hospitalId, fx.branchIds[0], fx.patientId, fx.userA],
        );
      });
    });

    it('refuses a weight nobody asserted', async () => {
      await withRollback(db, async (client) => {
        await refuses(
          client,
          /encounters_dosing_weight_attributed/,
          insertEncounter(`, dosing_weight_kg, dosing_weight_source`, `, 12.4, 'stated'`),
          [fx.hospitalId, fx.branchIds[0], fx.patientId],
        );
      });
    });

    it('refuses "measured" that names no measurement', async () => {
      await withRollback(db, async (client) => {
        await refuses(
          client,
          /encounters_dosing_weight_measured_source/,
          insertEncounter(
            `, dosing_weight_kg, dosing_weight_source, dosing_weight_at, dosing_weight_by`,
            `, 12.4, 'measured', now(), $4`,
          ),
          [fx.hospitalId, fx.branchIds[0], fx.patientId, fx.userA],
        );
      });
    });

    it('accepts "unknown", because not knowing is the honest default', async () => {
      await withRollback(db, async (client) => {
        await client.query(insertEncounter('', ''), [fx.hospitalId, fx.branchIds[0], fx.patientId]);
        const row = await client.rows<{ source: string; kg: string | null }>(
          `SELECT dosing_weight_source::text AS source, dosing_weight_kg AS kg
             FROM clinical.encounters WHERE patient_id = $1 ORDER BY created_at DESC LIMIT 1`,
          [fx.patientId],
        );
        expect(row[0]).toStrictEqual({ source: 'unknown', kg: null });
      });
    });

    it('cannot store a per-kg prescription line without a positive weight', async () => {
      await withRollback(db, async (client) => {
        const [rx] = await client.rows<{ id: string }>(
          `INSERT INTO clinical.prescriptions
             (id, hospital_id, branch_id, patient_id, doctor_user_id, status, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, 'draft', now())
           RETURNING id`,
          [fx.hospitalId, fx.branchIds[0], fx.patientId, fx.userA],
        );
        if (rx === undefined) throw new Error('fixture: the prescription was not created');

        const line = (columns: string, values: string): string =>
          `INSERT INTO clinical.prescription_items
             (id, hospital_id, prescription_id, line_no, generic_name, dose_qty, dose_basis, updated_at${columns})
           VALUES (gen_random_uuid(), $1, $2, 1, 'PARACETAMOL', 15, 'per_kg', now()${values})`;

        // This is the replay path the whole constraint exists for: the doctor
        // PWA flushing a mutation queued offline against an encounter whose
        // weight was never captured. No service check is in that path.
        await refuses(client, /prescription_items_weight_required_per_kg/, line('', ''), [
          fx.hospitalId,
          rx.id,
        ]);
        // A nought is refused by whichever of the pair reaches it first: the
        // per-kg rule reads "positive", the plausibility rule reads ">= 0.3".
        // Either alone closes this hole, which is why the assertion accepts
        // both — and the NULL case above is what pins `..._required_per_kg`.
        await refuses(
          client,
          /prescription_items_weight_(required_per_kg|plausible)/,
          line(', weight_used_kg', ', 0'),
          [fx.hospitalId, rx.id],
        );
        await refuses(client, /prescription_items_weight_plausible/, line(', weight_used_kg', ', 0.05'), [
          fx.hospitalId,
          rx.id,
        ]);

        // The control: with a real weight the same line stores.
        await client.query(line(', weight_used_kg', ', 12.4'), [fx.hospitalId, rx.id]);
        const stored = await client.scalar<string>(
          `SELECT weight_used_kg::text FROM clinical.prescription_items WHERE prescription_id = $1`,
          [rx.id],
        );
        expect(Number(stored)).toBe(12.4);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Every override is coded.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('an override of a fired alert', () => {
    /**
     * Fires one alert and returns its composite key.
     *
     * `cdss_alert_events_provenance` requires an event to name either a rule
     * version or a floor entry, so a non-floor alert is fired from the seeded
     * tunable rule version instead — that is the shape the "every override is
     * coded" rule has to hold for, independently of the floor countersignature.
     */
    const firedAlert = async (
      client: TenantClient,
      floorKey: string | null,
    ): Promise<{ id: string; firedAt: Date }> => {
      const [event] = await client.rows<{ id: string; fired_at: Date }>(
        `INSERT INTO clinical.cdss_alert_events
           (id, hospital_id, branch_id, patient_id, family, severity, interruption, trigger,
            fired_at, outcome, snapshot_digest, title, safety_floor_key, rule_version_id)
         VALUES (gen_random_uuid(), $1, $2, $3, 'allergy', 'contraindicated', 'hard_stop',
                 'order_entry', now(), 'hard_stop_blocked', $4,
                 'Documented penicillin anaphylaxis', $5, $6)
         RETURNING id, fired_at`,
        [
          fx.hospitalId,
          fx.branchIds[0],
          fx.patientId,
          hex64('a'),
          floorKey,
          floorKey === null ? fx.tunableRuleVersionId : null,
        ],
      );
      if (event === undefined) throw new Error('fixture: the alert event was not created');
      return { id: event.id, firedAt: event.fired_at };
    };

    it('refuses an override with no coded reason', async () => {
      await withRollback(db, async (client) => {
        // Deliberately a NON-floor alert. On a floor alert the countersignature
        // trigger fires first and the test would pass with the coded-reason
        // CHECK removed — a green test proving the wrong guard.
        const alert = await firedAlert(client, null);
        // Free text alone is a word cloud, not a governance input (EN-029 §5).
        await refuses(
          client,
          /cdss_alert_actions_override_coded/,
          `INSERT INTO clinical.cdss_alert_actions
             (id, hospital_id, alert_event_id, alert_fired_at, kind, override_note, actor_user_id)
           VALUES (gen_random_uuid(), $1, $2, $3, 'overridden', 'I know what I am doing', $4)`,
          [fx.hospitalId, alert.id, alert.firedAt, fx.userA],
        );
      });
    });

    it('refuses an override of a floor family without the countersignature the floor names', async () => {
      await withRollback(db, async (client) => {
        const alert = await firedAlert(client, 'allergy_documented_anaphylaxis');

        await refuses(
          client,
          /may be acknowledged only with a consultant countersignature/,
          `INSERT INTO clinical.cdss_alert_actions
             (id, hospital_id, alert_event_id, alert_fired_at, kind,
              override_reason_id, override_reason_code, actor_user_id)
           VALUES (gen_random_uuid(), $1, $2, $3, 'overridden', $4, $5, $6)`,
          [fx.hospitalId, alert.id, alert.firedAt, fx.overrideReasonId, fx.overrideReasonCode, fx.userA],
        );

        // The control: countersigned, the same override is recorded. Without it
        // the assertion above would also hold if the table rejected every insert.
        await client.query(
          `INSERT INTO clinical.cdss_alert_actions
             (id, hospital_id, alert_event_id, alert_fired_at, kind,
              override_reason_id, override_reason_code, actor_user_id,
              countersigned_by, countersigned_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'overridden', $4, $5, $6, $7, now())`,
          [
            fx.hospitalId,
            alert.id,
            alert.firedAt,
            fx.overrideReasonId,
            fx.overrideReasonCode,
            fx.userA,
            fx.userB,
          ],
        );
        const kinds = await client.rows<{ kind: string }>(
          `SELECT kind::text AS kind FROM clinical.cdss_alert_actions WHERE alert_event_id = $1`,
          [alert.id],
        );
        expect(kinds).toStrictEqual([{ kind: 'overridden' }]);
      });
    });

    it('admits no override at all where the floor names no countersigning role', async () => {
      await withRollback(db, async (client) => {
        // `pregnancy_category_x` has `countersign_role IS NULL`: the order has to
        // change, and there is no signature that makes it acceptable.
        const alert = await firedAlert(client, 'pregnancy_category_x');
        await refuses(
          client,
          /admits no override at all/,
          `INSERT INTO clinical.cdss_alert_actions
             (id, hospital_id, alert_event_id, alert_fired_at, kind,
              override_reason_id, override_reason_code, actor_user_id,
              countersigned_by, countersigned_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'overridden', $4, $5, $6, $7, now())`,
          [
            fx.hospitalId,
            alert.id,
            alert.firedAt,
            fx.overrideReasonId,
            fx.overrideReasonCode,
            fx.userA,
            fx.userB,
          ],
        );
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Destruction protects medico-legal records.
  // ═══════════════════════════════════════════════════════════════════════════
  describe('an MRD destruction run', () => {
    const mrdRecord = async (client: TenantClient, medicoLegal: boolean): Promise<string> => {
      const [row] = await client.rows<{ id: string }>(
        `INSERT INTO clinical.mrd_records
           (id, hospital_id, branch_id, patient_id, encounter_kind, encounter_ref, status,
            is_medico_legal, ml_reason, ml_flagged_by, ml_flagged_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, gen_random_uuid(), 'complete',
                 $5, $6, $7, $8, now())
         RETURNING id`,
        [
          fx.hospitalId,
          fx.branchIds[0],
          fx.patientId,
          medicoLegal ? 'mlc_op' : 'op',
          medicoLegal,
          medicoLegal ? 'Assault case, FIR 214/2026' : null,
          medicoLegal ? fx.userA : null,
          medicoLegal ? new Date() : null,
        ],
      );
      if (row === undefined) throw new Error('fixture: the MRD record was not created');
      return row.id;
    };

    const approveRun = (recordIds: string, approvers: string): string =>
      `INSERT INTO clinical.mrd_destruction_runs
         (id, hospital_id, proposed_by, record_ids, approved_by, approved_at, status, updated_at)
       VALUES (gen_random_uuid(), $1, $2, ${recordIds}, ${approvers}, now(), 'approved', now())`;

    it('refuses a run containing a medico-legal record', async () => {
      await withRollback(db, async (client) => {
        const protectedId = await mrdRecord(client, true);
        // Refused at *approval*, not only at execution: an approved run is one
        // somebody will execute, and the moment to fail is while a human is
        // still reading the screen.
        await refuses(
          client,
          /includes protected record\(s\).*medico-legal/s,
          approveRun('ARRAY[$3]::uuid[]', 'ARRAY[$4, $5]::uuid[]'),
          [fx.hospitalId, fx.userA, protectedId, fx.userB, fx.userC],
        );
      });
    });

    it('refuses a run whose two approvers are the same person', async () => {
      await withRollback(db, async (client) => {
        const ordinaryId = await mrdRecord(client, false);
        // `cardinality(approved_by) >= 2` is satisfied here — one approval typed
        // twice. Distinctness is what the trigger adds, because a CHECK cannot
        // hold the subquery it needs.
        await refuses(
          client,
          /needs two distinct approvers/,
          approveRun('ARRAY[$3]::uuid[]', 'ARRAY[$4, $4]::uuid[]'),
          [fx.hospitalId, fx.userA, ordinaryId, fx.userB],
        );
      });
    });

    it('refuses a run approved by the person who proposed it', async () => {
      await withRollback(db, async (client) => {
        const ordinaryId = await mrdRecord(client, false);
        await refuses(
          client,
          /mrd_destruction_runs_proposer_not_approver/,
          approveRun('ARRAY[$3]::uuid[]', 'ARRAY[$2, $4]::uuid[]'),
          [fx.hospitalId, fx.userA, ordinaryId, fx.userB],
        );
      });
    });

    it('approves an ordinary record with two distinct approvers', async () => {
      await withRollback(db, async (client) => {
        const ordinaryId = await mrdRecord(client, false);
        // The control. Lawful destruction has to remain possible, or the three
        // refusals above are indistinguishable from a table nobody can write.
        await client.query(approveRun('ARRAY[$3]::uuid[]', 'ARRAY[$4, $5]::uuid[]'), [
          fx.hospitalId,
          fx.userA,
          ordinaryId,
          fx.userB,
          fx.userC,
        ]);
        const status = await client.scalar<string>(
          `SELECT status::text FROM clinical.mrd_destruction_runs WHERE $1 = ANY (record_ids)`,
          [ordinaryId],
        );
        expect(status).toBe('approved');
      });
    });

    it('refuses a run that includes a record under a live legal hold', async () => {
      await withRollback(db, async (client) => {
        const ordinaryId = await mrdRecord(client, false);
        await client.query(
          `UPDATE clinical.mrd_records SET legal_hold_until = current_date + 30 WHERE id = $1`,
          [ordinaryId],
        );
        await refuses(
          client,
          /includes protected record\(s\).*legal hold/s,
          approveRun('ARRAY[$3]::uuid[]', 'ARRAY[$4, $5]::uuid[]'),
          [fx.hospitalId, fx.userA, ordinaryId, fx.userB, fx.userC],
        );
      });
    });
  });
});

// ───────────────────────────── helpers ──────────────────────────────────────

/**
 * Runs a statement that MUST be refused, and fails loudly when it is not.
 *
 * The savepoint matters: PostgreSQL aborts the whole transaction on the first
 * error, so without one, the second refusal in a test would fail with
 * "current transaction is aborted" and prove nothing about the guard it aimed at.
 *
 * The `pattern` matters more. `rejects.toThrow()` with no pattern passes when the
 * statement fails for a reason that has nothing to do with the invariant — a
 * misspelt column, a missing fixture, a NOT NULL somewhere else — which is how a
 * suite ends up green over a database with no guards at all.
 */
async function refuses(
  client: TenantClient,
  pattern: RegExp,
  sql: string,
  values: readonly unknown[] = [],
): Promise<void> {
  await client.query('SAVEPOINT refusal_probe');
  let message: string | null = null;
  try {
    await client.query(sql, values);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT refusal_probe');
  }

  if (message === null) {
    throw new Error(
      `The database ACCEPTED a statement it must refuse (expected ${String(pattern)}):\n${sql.trim()}`,
    );
  }
  expect(message, `refused, but not for the expected reason:\n${sql.trim()}`).toMatch(pattern);
}

/** A 64-character lowercase-hex string, the shape every digest CHECK demands. */
function hex64(fill: string): string {
  return fill.repeat(64).slice(0, 64);
}

function tenantContext(fx: Fixture): {
  hospitalId: string;
  userId: string;
  scope: 'hospital';
  branchIds: readonly string[];
} {
  return {
    hospitalId: fx.hospitalId,
    userId: fx.userA,
    scope: 'hospital',
    // Without this the generated policy's branch arm matches nothing and every
    // assertion below it passes over an empty result set.
    branchIds: fx.branchIds,
  };
}

/**
 * Proves the tenancy scope is complete before anything is read through it.
 *
 * `clinical.cdss_rules` carries both `hospital_id` and `branch_id`, so its
 * policy exercises both arms. A context missing `app.branch_ids` returns zero
 * rows here — and would return zero rows for every other assertion in the same
 * block, silently.
 */
async function assertTenantContextIsComplete(client: TenantClient, fx: Fixture): Promise<void> {
  const visible = await client.scalar<string>(
    `SELECT count(*)::text FROM clinical.cdss_rules WHERE hospital_id = $1`,
    [fx.hospitalId],
  );
  expect(
    Number(visible ?? '0'),
    'the tenant context is incomplete: every assertion in this block would pass vacuously',
  ).toBeGreaterThan(0);
}

/** The next unused version number for a rule, so a rerun never collides. */
async function nextRuleVersion(client: TenantClient, ruleId: string): Promise<number> {
  const max = await client.scalar<string>(
    `SELECT COALESCE(max(version), 0)::text FROM clinical.cdss_rule_versions WHERE rule_id = $1`,
    [ruleId],
  );
  return Number(max ?? '0') + 1;
}

/**
 * The fixture, chosen deliberately rather than with `LIMIT 1`.
 *
 * Three distinct users are required (a proposer and two approvers), the hospital
 * must be the one whose CDSS rules the seed authored, and the branches must be
 * all of that hospital's — a partial branch list is the same defect as no branch
 * list at all, just harder to see.
 */
async function loadFixture(db: Pool): Promise<Fixture> {
  const { rows: hospitals } = await db.query<{ hospital_id: string }>(
    `SELECT DISTINCT hospital_id FROM clinical.cdss_rules
      WHERE hospital_id IS NOT NULL AND enforces_floor_key IS NOT NULL
      ORDER BY hospital_id LIMIT 1`,
  );
  const hospitalId = hospitals[0]?.hospital_id;
  if (hospitalId === undefined) {
    throw new Error('fixture: the demo seed produced no hospital with floor-enforcing CDSS rules');
  }

  const { rows: branches } = await db.query<{ id: string }>(
    `SELECT id FROM core.branches WHERE hospital_id = $1 ORDER BY id`,
    [hospitalId],
  );
  if (branches.length === 0) {
    throw new Error('fixture: the hospital has no branches, so no branch-scoped policy can match');
  }

  const { rows: users } = await db.query<{ id: string }>(
    `SELECT id FROM core.users WHERE hospital_id = $1 ORDER BY id LIMIT 3`,
    [hospitalId],
  );
  if (users.length < 3) {
    throw new Error('fixture: dual approval needs a proposer and two distinct approvers');
  }

  const { rows: patients } = await db.query<{ id: string }>(
    `SELECT id FROM patient.patients WHERE hospital_id = $1 AND merged_into_id IS NULL
      ORDER BY id LIMIT 1`,
    [hospitalId],
  );
  const patientId = patients[0]?.id;
  if (patientId === undefined) {
    throw new Error('fixture: the demo seed produced no unmerged patient for this hospital');
  }

  const { rows: reasons } = await db.query<{ id: string; code: string }>(
    `SELECT id, code FROM clinical.cdss_override_reasons
      WHERE code = 'NO_ALTERNATIVE' AND requires_free_text = false
      ORDER BY id LIMIT 1`,
  );
  const reason = reasons[0];
  if (reason === undefined) {
    throw new Error('fixture: the seeded override-reason master no longer carries NO_ALTERNATIVE');
  }

  const { rows: versions } = await db.query<{ id: string }>(
    `SELECT v.id FROM clinical.cdss_rule_versions v
       JOIN clinical.cdss_rules r ON r.id = v.rule_id
      WHERE r.hospital_id = $1 AND r.enforces_floor_key IS NULL
      ORDER BY v.id LIMIT 1`,
    [hospitalId],
  );
  const tunableVersion = versions[0];
  if (tunableVersion === undefined) {
    throw new Error('fixture: the demo seed published no version of a rule outside the safety floor');
  }

  return {
    hospitalId,
    branchIds: branches.map((b) => b.id),
    patientId,
    userA: users[0]!.id,
    userB: users[1]!.id,
    userC: users[2]!.id,
    overrideReasonId: reason.id,
    overrideReasonCode: reason.code,
    tunableRuleVersionId: tunableVersion.id,
  };
}
