import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/db/database.service.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type { CatalogueQuery } from './lab.schemas.js';
import type { LabRejectionReasonItem, LabTestCatalogueItem } from './lab.types.js';

/**
 * OP-004 §3.1 — the two catalogue reads this module cannot borrow.
 *
 * `services/api/src/modules/masters` owns the eight demographic lookups and the
 * departments/services/rooms catalogues, and everything that fits there is read
 * from there. The test catalogue does not fit: `GET /masters/{kind}` returns a
 * common `{code, name, …}` shape, and an orderable test is only useful with the
 * specimen, the container and the cap colour attached — that is what stops a
 * phlebotomist filling a lithium-heparin tube for a coagulation screen, and it
 * is a three-way join rather than a column. The rejection list is here for the
 * same reason: `lab.lab_rejection_reasons` lives in the `lab` schema, and
 * `docs/01 §4` keeps a module out of another module's tables.
 *
 * Both are effective-dated masters, and the predicate is not optional. A
 * superseded test version is still in the table with a closed `effective_to`; a
 * picker that showed it would let somebody order an assay the laboratory retired.
 */
@Injectable()
export class LabCatalogueService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async listTests(query: CatalogueQuery): Promise<{ readonly items: readonly LabTestCatalogueItem[] }> {
    const pattern = query.q === undefined ? null : `%${query.q.toLowerCase()}%`;

    const items = await this.db.withTenant(currentTenantContext(), async (tx) =>
      tx.rows<LabTestCatalogueItem>(
        `WITH live_tests AS (
           SELECT DISTINCT ON (t.record_key) t.*
             FROM mdm.mdm_lab_tests t
            WHERE t.status = 'active'
              AND t.effective_from <= now()
              AND (t.effective_to IS NULL OR t.effective_to > now())
            ORDER BY t.record_key, t.version DESC
         ),
         live_specimens AS (
           SELECT DISTINCT ON (s.record_key) s.record_key, s.name
             FROM mdm.mdm_lab_specimen_types s
            WHERE s.status = 'active'
              AND s.effective_from <= now()
              AND (s.effective_to IS NULL OR s.effective_to > now())
            ORDER BY s.record_key, s.version DESC
         ),
         live_containers AS (
           SELECT DISTINCT ON (c.record_key) c.record_key, c.name, c.cap_colour
             FROM mdm.mdm_lab_containers c
            WHERE c.status = 'active'
              AND c.effective_from <= now()
              AND (c.effective_to IS NULL OR c.effective_to > now())
            ORDER BY c.record_key, c.version DESC
         )
         SELECT t.record_key, t.code, t.name, t.short_code, t.loinc_code,
                t.discipline::text AS discipline, t.result_type::text AS result_type, t.unit,
                t.is_panel, sp.name AS specimen_type_name,
                ct.name AS container_name, ct.cap_colour,
                t.requires_fasting, t.is_sensitive, t.is_nabl_scope, t.is_orderable
           FROM live_tests t
           LEFT JOIN live_specimens sp ON sp.record_key = t.specimen_type_key
           LEFT JOIN live_containers ct ON ct.record_key = t.container_key
          WHERE ($1::text IS NULL OR lower(t.name) LIKE $1 OR lower(t.code) LIKE $1
                 OR lower(COALESCE(t.short_code, '')) LIKE $1)
            AND ($2::text IS NULL OR t.discipline = $2::mdm."LabDiscipline")
          ORDER BY t.discipline, t.name
          LIMIT $3`,
        [pattern, query.discipline ?? null, query.limit],
      ),
    );

    return { items };
  }

  /**
   * `OP-004 §3.2.3` — the reasons a specimen may be thrown away, as the hospital
   * configured them. A list rather than an enum, because "sample received after
   * pneumatic-tube failure" is a hospital's business and not the product's; and
   * a code rather than free text, because the rejection rate is a NABL
   * indicator and an indicator computed over free text is a word cloud.
   */
  async listRejectionReasons(): Promise<{ readonly items: readonly LabRejectionReasonItem[] }> {
    const items = await this.db.withTenant(currentTenantContext(), async (tx) =>
      tx.rows<LabRejectionReasonItem>(
        // `DISTINCT ON` fixes the row order to `record_key`, and the screen wants
        // the laboratory's own ordering — so the de-duplication and the ordering
        // are two steps rather than one.
        `SELECT live.record_key, live.code, live.label, live.nabl_category,
                live.requires_recollection, live.recollection_chargeable
           FROM (
             SELECT DISTINCT ON (r.record_key)
                    r.record_key, r.code, r.label, r.nabl_category,
                    r.requires_recollection, r.recollection_chargeable, r.sort_order
               FROM lab.lab_rejection_reasons r
              WHERE r.status = 'active'
                AND r.effective_from <= now()
                AND (r.effective_to IS NULL OR r.effective_to > now())
              ORDER BY r.record_key, r.version DESC
           ) live
          ORDER BY live.sort_order, live.label`,
        [],
      ),
    );

    return { items };
  }
}
