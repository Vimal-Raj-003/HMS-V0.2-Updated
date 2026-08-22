import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../../core/db/database.service.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import type { DrugSearchQuery } from './prescribing.schemas.js';
import type { DrugSearchResult } from './prescribing.types.js';

/**
 * OP-002 §3.3.1 — drug search, by generic or by brand.
 *
 * Two properties are load-bearing and neither is obvious from the SQL:
 *
 * **The result carries the safety flags, not just the name.** `is_high_alert`,
 * `is_lasa` and `tall_man_display` travel with every row because the picker is
 * where a look-alike/sound-alike pair is caught — "predniSONE" against
 * "predniSOLONE" is a rendering the master publishes, not one a UI invents.
 *
 * **The effective-dating predicate is not optional.** A superseded formulation
 * is still in the table with a closed `effective_to`; a picker that showed it
 * would let a doctor prescribe a strength the pharmacy no longer stocks.
 */
@Injectable()
export class DrugsService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async search(query: DrugSearchQuery): Promise<{ readonly items: readonly DrugSearchResult[] }> {
    const pattern = `%${query.q.trim().toLowerCase()}%`;
    const items = await this.db.withTenant(currentTenantContext(), async (tx) =>
      tx.rows<DrugSearchResult>(
        `SELECT d.record_key, d.code, d.generic_name, bm.brand_name, d.strength_text,
                d.form::text AS form, d.route::text AS route, d.schedule::text AS schedule,
                d.is_high_alert, d.is_lasa, d.tall_man_display, d.in_formulary
           FROM mdm.mdm_drugs d
           LEFT JOIN LATERAL (
             SELECT br.brand_name
               FROM mdm.mdm_drug_brands br
              WHERE br.drug_key = d.record_key
                AND br.status = 'active'
                AND br.effective_from <= now()
                AND (br.effective_to IS NULL OR br.effective_to > now())
                AND lower(br.brand_name) LIKE $1
              ORDER BY br.brand_name
              LIMIT 1
           ) bm ON true
          WHERE d.status = 'active'
            AND d.effective_from <= now()
            AND (d.effective_to IS NULL OR d.effective_to > now())
            AND (lower(d.generic_name) LIKE $1 OR lower(d.code) LIKE $1 OR bm.brand_name IS NOT NULL)
          ORDER BY d.generic_name
          LIMIT $2`,
        [pattern, query.limit],
      ),
    );
    return { items };
  }
}
