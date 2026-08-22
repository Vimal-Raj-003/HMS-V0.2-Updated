import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import type { Page } from '@vims/contracts';
import { Idempotent } from '../../../core/idempotency/idempotency.decorator.js';
import { Permission } from '../../../core/policy/permission.decorator.js';
import { ZodBody } from '../../../core/validation/zod.pipe.js';
import { PacsService, type RetentionPolicyRow } from './pacs.service.js';
import {
  idSchema,
  ingestStudySchema,
  mppsSchema,
  purgePlanSchema,
  reconcileStudySchema,
  revokeShareLinkSchema,
  shareLinkSchema,
  studyQuerySchema,
  viewerTokenSchema,
  type IngestStudyRequest,
  type MppsRequest,
  type PurgePlanRequest,
  type ReconcileStudyRequest,
  type RevokeShareLinkRequest,
  type ShareLinkRequest,
  type StudyQuery,
  type ViewerTokenRequest,
} from './radiology.schemas.js';
import type { PacsStudyView, ViewerGrantView } from './radiology.types.js';

/**
 * `/api/v1/pacs` — EN-008 §6.
 *
 * Three notes on the gating, because it is not obvious from the keys alone.
 *
 * `POST /pacs/studies/ingest` and `POST /pacs/mpps` are held by
 * `integration.rad.study` and `integration.rad.mpps`, which the catalogue says
 * are held "by a device or service token, never by a person". They are the
 * archive and the modality talking, not a user.
 *
 * `rad.study.read` and `rad.image.view` carry an ABAC scope the catalogue
 * cannot express — care-team-only, break-glass on a recorded reason,
 * assigned-studies-only for a tele-radiologist. Holding the key gets a caller as
 * far as `RadAccessService`, and no further.
 *
 * The viewer route returns a **token and an Orthanc object id**, never an image.
 * `EN-008 §5`: "direct Orthanc ports not exposed beyond hub/viewer gateway".
 * This service indexes the archive; it does not proxy it.
 */
@Controller()
export class PacsController {
  constructor(@Inject(PacsService) private readonly pacs: PacsService) {}

  @Permission('integration.rad.study')
  @Idempotent()
  @Post('pacs/studies/ingest')
  async ingest(@Body(new ZodBody(ingestStudySchema)) body: IngestStudyRequest): Promise<PacsStudyView> {
    return this.pacs.ingest(body);
  }

  @Permission('integration.rad.mpps')
  @Idempotent()
  @Post('pacs/mpps')
  async mpps(@Body(new ZodBody(mppsSchema)) body: MppsRequest): Promise<{ readonly accepted: true }> {
    return this.pacs.mpps(body);
  }

  @Permission('rad.study.read')
  @Get('pacs/studies')
  async list(@Query(new ZodBody(studyQuerySchema)) query: StudyQuery): Promise<Page<PacsStudyView>> {
    return this.pacs.listStudies(query);
  }

  @Permission('rad.study.read')
  @Get('pacs/studies/:id')
  async get(@Param('id', new ZodBody(idSchema)) id: string): Promise<PacsStudyView> {
    return this.pacs.getStudy(id);
  }

  /** Every issue is written to `pacs_view_audit` before the token exists. */
  @Permission('rad.image.view')
  @Idempotent()
  @Post('pacs/studies/:id/viewer-token')
  async viewerToken(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(viewerTokenSchema)) body: ViewerTokenRequest,
  ): Promise<ViewerGrantView> {
    return this.pacs.issueViewerToken(id, body);
  }

  @Permission('rad.study.reconcile')
  @Get('pacs/reconciliation')
  async reconciliationQueue(
    @Query(new ZodBody(studyQuerySchema)) query: StudyQuery,
  ): Promise<Page<PacsStudyView>> {
    return this.pacs.listStudies({ ...query, reconciliationStatus: 'needs_review' });
  }

  /** `rad.study.reconcile` is `requiresReason`: this is always a named human decision. */
  @Permission('rad.study.reconcile')
  @Idempotent()
  @Post('pacs/studies/:id/reconcile')
  async reconcile(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(reconcileStudySchema)) body: ReconcileStudyRequest,
  ): Promise<PacsStudyView> {
    return this.pacs.reconcile(id, body);
  }

  @Permission('rad.image.share')
  @Idempotent()
  @Post('pacs/share-links')
  async share(@Body(new ZodBody(shareLinkSchema)) body: ShareLinkRequest): Promise<{
    readonly id: string;
    readonly token: string;
    readonly expiresAt: string;
    readonly maxViews: number;
  }> {
    return this.pacs.createShareLink(body);
  }

  @Permission('rad.image.share')
  @Idempotent()
  @Post('pacs/share-links/:id/revoke')
  async revoke(
    @Param('id', new ZodBody(idSchema)) id: string,
    @Body(new ZodBody(revokeShareLinkSchema)) body: RevokeShareLinkRequest,
  ): Promise<{ readonly revoked: true }> {
    return this.pacs.revokeShareLink(id, body);
  }

  @Permission('rad.pacs.read')
  @Get('pacs/retention-policies')
  async retention(): Promise<{ readonly items: readonly RetentionPolicyRow[] }> {
    return this.pacs.retentionPolicies();
  }

  /**
   * Planning and approving a purge.
   *
   * Both routes are decorated with `rad.pacs.read` — the key every archive
   * administrator holds and a genuine precondition, because you cannot plan a
   * purge of an archive you may not see — and the real authority,
   * `rad.pacs.retention`, is asserted inside the service with the first approver
   * attached as the co-signer. That indirection is not a way around the
   * catalogue: `rad.pacs.retention` is flagged `requiresSecondPerson`, and the
   * global `PolicyGuard` has no way to carry a co-signer, so a route decorated
   * with it would be refused for everybody, always. `cash/cosign.service.ts`
   * records the same finding and the same remedy.
   */
  @Permission('rad.pacs.read')
  @Idempotent()
  @Post('pacs/purge-runs')
  async planPurge(
    @Body(new ZodBody(purgePlanSchema)) body: PurgePlanRequest,
  ): Promise<{ readonly id: string; readonly studyCount: number }> {
    return this.pacs.planPurge(body);
  }

  @Permission('rad.pacs.read')
  @Idempotent()
  @Post('pacs/purge-runs/:id/approve')
  async approvePurge(@Param('id', new ZodBody(idSchema)) id: string): Promise<{ readonly status: string }> {
    return this.pacs.approvePurge(id);
  }
}
