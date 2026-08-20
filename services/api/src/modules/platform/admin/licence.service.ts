import { Inject, Injectable } from '@nestjs/common';
import { CLINICAL_SAFETY_EXEMPT_KEYS, type DegradationTierSpec } from '@vims/contracts';
import { DatabaseService } from '../../../core/db/database.service.js';
import { currentTenantContext } from '../../../core/tenancy/tenant-context.js';
import {
  resolveEntitlements,
  tierSpec,
  type EntitlementRow,
  type ResolvedEntitlement,
} from './entitlements.logic.js';

export interface SubscriptionSummary {
  readonly id: string;
  readonly status: string;
  readonly degradeTier: number;
  readonly startsAt: string;
  readonly endsAt: string | null;
  readonly graceUntil: string | null;
  readonly renewalMode: string;
  readonly currency: string;
}

export interface LicenceState {
  readonly subscription: SubscriptionSummary | null;
  readonly tier: DegradationTierSpec;
  readonly entitlements: readonly ResolvedEntitlement[];
  /** `EN-040 §5`: the keys no commercial state may ever gate. */
  readonly clinicalSafetyExemptKeys: readonly string[];
  /** True when nothing is recorded and every answer is the declared default. */
  readonly usingDefaults: boolean;
}

/**
 * EN-040 §6 — the licence panel of the admin console.
 *
 * Read-only here on purpose. Changing a subscription is `lic.subscription.manage`
 * and belongs to the SaaS operator, not to the hospital administrator reading
 * this screen: `EN-040 §5` requires every deviation from a plan to be an audited
 * override with an approver and an expiry, which is a different surface entirely.
 *
 * A tenant with no subscription row is not an error. On-prem deployments and
 * pre-billing installations are legitimately unlicensed, and `EN-040 §3.2` says
 * what to do about it — fail open for clinical capability, closed for commercial
 * — which `resolveEntitlements` applies. Reporting "no licence" as a failure
 * would take an on-prem hospital offline for a commercial reason, which is the
 * single outcome EN-040 exists to prevent.
 */
@Injectable()
export class LicenceService {
  constructor(@Inject(DatabaseService) private readonly db: DatabaseService) {}

  async state(): Promise<LicenceState> {
    return this.db.withTenant(currentTenantContext(), async (tx) => {
      const subscription = await tx.maybeOne<{
        id: string;
        status: string;
        degrade_tier: number;
        starts_at: Date;
        ends_at: Date | null;
        grace_until: Date | null;
        renewal_mode: string;
        currency: string;
      }>(
        `SELECT id, status::text AS status, degrade_tier, starts_at, ends_at, grace_until,
                renewal_mode, currency
           FROM core.lic_subscriptions
          ORDER BY starts_at DESC
          LIMIT 1`,
      );

      const rows = await tx.rows<EntitlementRow>(
        `SELECT key, allowed, limit_value::text AS limit_value, degrade_mode, source,
                effective_from, effective_to
           FROM core.lic_entitlements
          WHERE effective_from <= now()
            AND (effective_to IS NULL OR effective_to > now())`,
      );

      return {
        subscription:
          subscription === undefined
            ? null
            : {
                id: subscription.id,
                status: subscription.status,
                degradeTier: subscription.degrade_tier,
                startsAt: subscription.starts_at.toISOString(),
                endsAt: subscription.ends_at?.toISOString() ?? null,
                graceUntil: subscription.grace_until?.toISOString() ?? null,
                renewalMode: subscription.renewal_mode,
                currency: subscription.currency,
              },
        tier: tierSpec(subscription?.degrade_tier ?? 0),
        entitlements: resolveEntitlements(rows),
        clinicalSafetyExemptKeys: CLINICAL_SAFETY_EXEMPT_KEYS,
        usingDefaults: subscription === undefined && rows.length === 0,
      };
    });
  }

  /** The resolved entitlement set alone — what the flags screen checks against. */
  async entitlements(): Promise<readonly ResolvedEntitlement[]> {
    return (await this.state()).entitlements;
  }
}
