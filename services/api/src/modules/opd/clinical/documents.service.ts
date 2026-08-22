import { Inject, Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { AuditService } from '../../../core/audit/audit.service.js';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { AppError } from '../../../core/problem/app-error.js';
import { mapClinicalConstraints } from './clinical.common.js';

/**
 * The versioned, signed, hash-chained clinical document store
 * (`clinical.documents` + `clinical.document_versions`).
 *
 * **This service does not compute the hash and does not link the chain.** The
 * database does, in `clinical.seal_document_version()`: `content_sha256` is
 * derived from the content and `prev_sha256` is taken from the actual preceding
 * row. A hash chain whose links the writer supplies proves only that the writer
 * can compute SHA-256, so the writer is not asked for them.
 *
 * **An amendment is an insert, never an update.** After a version leaves
 * `draft`, `clinical.enforce_document_version_immutability()` refuses any UPDATE
 * that touches content, hash, signature or identity, and refuses every DELETE;
 * §D of the migration then revokes DELETE from the application role entirely.
 * So `amend()` writes version N+1 with a reason and marks version N superseded —
 * the only two columns the trigger still permits — and version N stays `final`,
 * readable, and carrying its own signature. That is phase-02 exit gate 4.
 *
 * A draft, by contrast, is genuinely mutable: the trigger returns early when
 * `OLD.status = 'draft'`. That is what makes a five-second autosave loop legal
 * without weakening anything about signed notes.
 */
@Injectable()
export class ClinicalDocumentService {
  constructor(@Inject(AuditService) private readonly audit: AuditService) {}

  /** Opens document version 1 in `draft`. Returns the document id. */
  async openDraft(
    tx: TransactionClient,
    input: {
      readonly branchId: string;
      readonly patientId: string;
      readonly encounterId: string | null;
      readonly visitId: string | null;
      readonly type: string;
      readonly title: string;
      readonly content: Readonly<Record<string, unknown>>;
      readonly contentText: string | null;
    },
  ): Promise<string> {
    const ctx = getContext();
    const documentId = newId();

    await tx.query(
      `INSERT INTO clinical.documents (
         id, hospital_id, branch_id, patient_id, encounter_id, visit_id,
         type, title, owner_module, created_by, updated_by, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::clinical."ClinicalDocumentType", $8, 'OP-002', $9, $9, now())`,
      [
        documentId,
        ctx.hospitalId,
        input.branchId,
        input.patientId,
        input.encounterId,
        input.visitId,
        input.type,
        input.title,
        ctx.userId,
      ],
    );

    await mapClinicalConstraints(async () =>
      tx.query(
        `INSERT INTO clinical.document_versions (
           id, hospital_id, document_id, version, status, content, content_text,
           content_sha256, created_by
         ) VALUES ($1, $2, $3, 1, 'draft', $4::jsonb, $5, '', $6)`,
        [newId(), ctx.hospitalId, documentId, JSON.stringify(input.content), input.contentText, ctx.userId],
      ),
    );

    return documentId;
  }

  /**
   * Replaces the content of the current **draft** version.
   *
   * Refuses once the version has been signed, which is not a service policy but
   * the database's: the trigger would raise, and catching it here lets the
   * caller be told to amend instead of being handed a 500.
   */
  async updateDraft(
    tx: TransactionClient,
    documentId: string,
    content: Readonly<Record<string, unknown>>,
    contentText: string | null,
  ): Promise<void> {
    const head = await this.head(tx, documentId);
    if (head.status !== 'draft') {
      throw AppError.conflict(
        'That note has been signed. Record an amendment instead — it creates a new version with a reason, and the original stays.',
      );
    }

    await mapClinicalConstraints(async () =>
      tx.query(
        `UPDATE clinical.document_versions
            SET content = $2::jsonb, content_text = $3
          WHERE document_id = $1 AND version = $4`,
        [documentId, JSON.stringify(content), contentText, head.version],
      ),
    );
  }

  /**
   * Signs the current draft: `draft → final`, with the signer, the instant, the
   * method and the professional registration captured **at signing time** so a
   * later change to the practitioner master cannot rewrite what was signed.
   */
  async sign(
    tx: TransactionClient,
    input: {
      readonly documentId: string;
      readonly patientId: string;
      readonly signMethod: string;
      readonly content?: Readonly<Record<string, unknown>> | undefined;
      readonly contentText?: string | null | undefined;
    },
  ): Promise<SignedVersion> {
    const ctx = getContext();
    const head = await this.head(tx, input.documentId);
    if (head.status !== 'draft') {
      throw AppError.conflict('That note has already been signed.');
    }

    const registration = await this.registrationOf(tx, ctx.userId);

    const signed = await mapClinicalConstraints(async () =>
      tx.one<{ version: number; content_sha256: string; signed_at: Date }>(
        `UPDATE clinical.document_versions
            SET status = 'final',
                content = COALESCE($2::jsonb, content),
                content_text = COALESCE($3, content_text),
                signed_by = $4, signed_at = now(),
                sign_method = $5::clinical."SignMethod",
                signer_registration_no = $6
          WHERE document_id = $1 AND version = $7
        RETURNING version, content_sha256, signed_at`,
        [
          input.documentId,
          input.content === undefined ? null : JSON.stringify(input.content),
          input.contentText ?? null,
          ctx.userId,
          input.signMethod,
          registration,
          head.version,
        ],
      ),
    );

    await this.audit.write(tx, {
      action: 'sign',
      entity: 'clinical.document_versions',
      rowId: input.documentId,
      businessKey: null,
      dataClass: 'phi',
      patientId: input.patientId,
      before: { status: 'draft' },
      after: {
        status: 'final',
        version: signed.version,
        content_sha256: signed.content_sha256,
        sign_method: input.signMethod,
        signer_registration_no: registration,
      },
      artifactSha256: signed.content_sha256,
    });

    return { version: signed.version, contentSha256: signed.content_sha256, signedAt: signed.signed_at };
  }

  /**
   * OP-002 §14 AC-9 — the amendment.
   *
   * Version N+1 is inserted with the reason and signed; version N is then
   * marked `amended` and superseded. Nothing about version N's content, hash or
   * signature changes, and the chain still verifies, because the new version's
   * `prev_sha256` is taken by the trigger from N's stored digest.
   */
  async amend(
    tx: TransactionClient,
    input: {
      readonly documentId: string;
      readonly patientId: string;
      readonly reason: string;
      readonly content: Readonly<Record<string, unknown>>;
      readonly contentText: string | null;
      readonly signMethod: string;
    },
  ): Promise<SignedVersion> {
    const ctx = getContext();
    const head = await this.head(tx, input.documentId);
    if (head.status === 'draft') {
      throw AppError.conflict('That note has not been signed yet. Edit the draft rather than amending it.');
    }
    if (head.status === 'cancelled') {
      throw AppError.conflict('That note has been retracted and cannot be amended.');
    }

    const registration = await this.registrationOf(tx, ctx.userId);
    const nextVersion = head.version + 1;

    const created = await mapClinicalConstraints(async () =>
      tx.one<{ version: number; content_sha256: string; signed_at: Date; prev_sha256: string | null }>(
        `INSERT INTO clinical.document_versions (
           id, hospital_id, document_id, version, status, content, content_text,
           content_sha256, signed_by, signed_at, sign_method, signer_registration_no,
           amendment_reason, created_by
         ) VALUES ($1, $2, $3, $4, 'final', $5::jsonb, $6, '', $7, now(), $8::clinical."SignMethod", $9, $10, $7)
         RETURNING version, content_sha256, signed_at, prev_sha256`,
        [
          newId(),
          ctx.hospitalId,
          input.documentId,
          nextVersion,
          JSON.stringify(input.content),
          input.contentText,
          ctx.userId,
          input.signMethod,
          registration,
          input.reason,
        ],
      ),
    );

    // The only UPDATE the immutability trigger still permits on a final row:
    // the supersession pair, plus the single status transition that accompanies
    // it. Content, hash and signature are untouched — that is the point.
    await mapClinicalConstraints(async () =>
      tx.query(
        `UPDATE clinical.document_versions
            SET status = 'amended', superseded_by_version = $3, superseded_at = now()
          WHERE document_id = $1 AND version = $2`,
        [input.documentId, head.version, nextVersion],
      ),
    );

    await this.audit.write(tx, {
      action: 'update',
      entity: 'clinical.document_versions',
      rowId: input.documentId,
      businessKey: null,
      dataClass: 'phi',
      patientId: input.patientId,
      before: { version: head.version, status: head.status },
      after: {
        version: created.version,
        status: 'final',
        content_sha256: created.content_sha256,
        prev_sha256: created.prev_sha256,
        supersedes_version: head.version,
      },
      reasonText: input.reason,
      artifactSha256: created.content_sha256,
    });

    return {
      version: created.version,
      contentSha256: created.content_sha256,
      signedAt: created.signed_at,
    };
  }

  /** Every version of a document, oldest first. Content included: this is the record. */
  async versions(tx: TransactionClient, documentId: string): Promise<readonly DocumentVersionView[]> {
    return tx.rows<DocumentVersionView>(
      `SELECT version, status::text AS status, content, content_text, content_sha256, prev_sha256,
              signed_by, signed_at, sign_method::text AS sign_method, signer_registration_no,
              amendment_reason, superseded_by_version, superseded_at, created_at, created_by
         FROM clinical.document_versions
        WHERE document_id = $1
        ORDER BY version ASC`,
      [documentId],
    );
  }

  /**
   * Re-derives every digest from its own content and re-walks every link, using
   * the database's own `clinical.verify_document_chain()`.
   *
   * The point of a verifier is not to trust that the trigger worked.
   */
  async verifyChain(tx: TransactionClient, documentId: string): Promise<ChainVerification> {
    const rows = await tx.rows<{
      version: number;
      status: string;
      hash_matches: boolean;
      link_matches: boolean;
    }>(`SELECT version, status, hash_matches, link_matches FROM clinical.verify_document_chain($1)`, [
      documentId,
    ]);

    return {
      valid: rows.every((row) => row.hash_matches && row.link_matches),
      versions: rows,
    };
  }

  private async head(
    tx: TransactionClient,
    documentId: string,
  ): Promise<{ readonly version: number; readonly status: string }> {
    const row = await tx.maybeOne<{ version: number; status: string }>(
      `SELECT version, status::text AS status
         FROM clinical.document_versions
        WHERE document_id = $1
        ORDER BY version DESC
        LIMIT 1`,
      [documentId],
    );
    if (row === undefined) throw AppError.notFound('The clinical document');
    return row;
  }

  /**
   * The signer's NMC/state-council registration number, from the practitioner
   * master. Null for a user with no practitioner profile, which is legitimate:
   * a nurse signing a nursing note has no medical registration, and inventing
   * one would be worse than recording none.
   */
  private async registrationOf(tx: TransactionClient, userId: string | null): Promise<string | null> {
    if (userId === null) return null;
    const row = await tx.maybeOne<{ registration_number: string | null }>(
      `SELECT registration_number
         FROM mdm.mdm_practitioners
        WHERE user_id = $1 AND status = 'active'
        ORDER BY version DESC
        LIMIT 1`,
      [userId],
    );
    return row?.registration_number ?? null;
  }
}

export interface SignedVersion {
  readonly version: number;
  readonly contentSha256: string;
  readonly signedAt: Date;
}

export interface DocumentVersionView {
  readonly version: number;
  readonly status: string;
  readonly content: Record<string, unknown>;
  readonly content_text: string | null;
  readonly content_sha256: string;
  readonly prev_sha256: string | null;
  readonly signed_by: string | null;
  readonly signed_at: Date | null;
  readonly sign_method: string | null;
  readonly signer_registration_no: string | null;
  readonly amendment_reason: string | null;
  readonly superseded_by_version: number | null;
  readonly superseded_at: Date | null;
  readonly created_at: Date;
  readonly created_by: string | null;
}

export interface ChainVerification {
  readonly valid: boolean;
  readonly versions: readonly {
    readonly version: number;
    readonly status: string;
    readonly hash_matches: boolean;
    readonly link_matches: boolean;
  }[];
}
