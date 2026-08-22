import { Injectable } from '@nestjs/common';
import { newId } from '@vims/contracts';
import { getContext } from '../../../core/context/request-context.js';
import type { TransactionClient } from '../../../core/db/database.service.js';
import { dobWithinOneYear, scoreDuplicate, type DuplicateScore } from './patient.identity.js';

/**
 * Duplicate detection — OP-001 §3.1 step 2 and §5's scoring table.
 *
 * The shape of this file is dictated by one rule: **each scoring rule gets its
 * own index probe.** Written as a single query, the rules would be
 *
 *   WHERE abha_number = $1 OR mobile = $2 OR full_name % $3 OR dedupe_fingerprint = $4
 *
 * and PostgreSQL would use none of the five indexes the Phase-1 migration built
 * for exactly these predicates — it would sequentially scan the MPI, on the
 * highest-traffic screen in the hospital, once per keystroke. So the probes run
 * separately, each hitting the index it was designed for, and the union of their
 * ids is fetched once and scored in TypeScript.
 *
 * The probes are cheap: every one is an equality or prefix probe returning a
 * handful of rows, and the whole set is bounded by `CANDIDATE_LIMIT`.
 *
 * `docs/07` §4 budgets 400 ms for a registration including numbering; this is
 * the part of it that grows with the size of the MPI, so it is the part that had
 * to be index-shaped rather than merely correct.
 */

/**
 * A ceiling on how many candidates any one probe contributes.
 *
 * A shared family mobile legitimately returns up to ten rows (OP-001 §5 caps it
 * at a configurable ten), and a common name returns more. Past this many the
 * answer is not "which of these is the same person" but "your search was too
 * broad", and scoring a thousand rows to tell the receptionist that would spend
 * the registration budget on a question nobody asked.
 */
const CANDIDATE_LIMIT = 25;

export interface DuplicateProbeInput {
  readonly fullName: string;
  readonly gender: string;
  readonly dob: string | null;
  readonly mobileE164: string;
  readonly fingerprint: string;
  readonly abhaNumberVariants: readonly string[];
  readonly abhaAddress: string | null;
  /**
   * The peppered Aadhaar digest, when one exists.
   *
   * Nothing supplies it today — this module never receives an Aadhaar number in
   * any form (see `PatientService.register`) — but the probe and the 1.0 rule
   * are implemented so that EN-011's e-KYC path can populate it without
   * re-deriving the scoring table.
   */
  readonly aadhaarHash: Buffer | null;
  /** Excluded from its own candidate set when re-scoring an existing record. */
  readonly excludePatientId: string | null;
}

export interface DuplicateCandidate extends DuplicateScore {
  readonly patientId: string;
  readonly uhid: string;
  readonly fullName: string;
  readonly gender: string;
  readonly dob: string | null;
  readonly ageYears: number | null;
  readonly lastVisitAt: Date | null;
  readonly status: string;
}

interface CandidateRow {
  readonly id: string;
  readonly uhid: string;
  readonly full_name: string;
  readonly gender: string;
  readonly dob_text: string | null;
  readonly age_years: number | null;
  readonly mobile: string;
  readonly abha_number: string | null;
  readonly abha_address: string | null;
  readonly dedupe_fingerprint: string;
  readonly aadhaar_hash: Buffer | null;
  readonly last_visit_at: Date | null;
  readonly status: string;
  readonly name_similarity: number;
}

@Injectable()
export class PatientDedupeService {
  /**
   * Finds and scores every record that could be the same person.
   *
   * Returns them sorted with the strongest first, which is the order the
   * candidate list is shown in and the order the hard-stop message reads.
   */
  async findCandidates(
    tx: TransactionClient,
    input: DuplicateProbeInput,
  ): Promise<readonly DuplicateCandidate[]> {
    const ids = new Set<string>();
    const collect = (rows: readonly { readonly id: string }[]): void => {
      for (const row of rows) {
        if (row.id !== input.excludePatientId) ids.add(row.id);
      }
    };

    // Rule 1.0 — exact ABHA. Two partial indexes, probed separately:
    // `idx_patients_abha_number` and `idx_patients_abha_address`.
    if (input.abhaNumberVariants.length > 0) {
      collect(
        await tx.rows<{ id: string }>(
          `SELECT id FROM patient.patients
            WHERE abha_number IS NOT NULL AND abha_number = ANY($1::varchar[])
              AND deleted_at IS NULL
            LIMIT ${CANDIDATE_LIMIT}`,
          [input.abhaNumberVariants],
        ),
      );
    }
    if (input.abhaAddress !== null) {
      collect(
        await tx.rows<{ id: string }>(
          `SELECT id FROM patient.patients
            WHERE abha_address IS NOT NULL AND abha_address = $1
              AND deleted_at IS NULL
            LIMIT ${CANDIDATE_LIMIT}`,
          [input.abhaAddress],
        ),
      );
    }

    // Rule 1.0 — exact Aadhaar digest. `idx_patients_aadhaar_hash`.
    if (input.aadhaarHash !== null) {
      collect(
        await tx.rows<{ id: string }>(
          `SELECT id FROM patient.patients
            WHERE aadhaar_hash IS NOT NULL AND aadhaar_hash = $1
              AND deleted_at IS NULL
            LIMIT ${CANDIDATE_LIMIT}`,
          [input.aadhaarHash],
        ),
      );
    }

    // Rule 0.9 — the deterministic fingerprint, on its own btree index
    // (`hospital_id, dedupe_fingerprint`).
    collect(
      await tx.rows<{ id: string }>(
        `SELECT id FROM patient.patients
          WHERE dedupe_fingerprint = $1 AND deleted_at IS NULL
          LIMIT ${CANDIDATE_LIMIT}`,
        [input.fingerprint],
      ),
    );

    // Rule 0.9 — mobile + DOB. The `(hospital_id, mobile)` btree, then the DOB
    // filter on the handful of rows a shared family number returns.
    if (input.dob !== null) {
      collect(
        await tx.rows<{ id: string }>(
          `SELECT id FROM patient.patients
            WHERE mobile = $1 AND dob = $2::date AND deleted_at IS NULL
            LIMIT ${CANDIDATE_LIMIT}`,
          [input.mobileE164, input.dob],
        ),
      );

      // Rule 0.85 — name trigram with gender and DOB ± 1 year.
      // `idx_patients_active_name_trgm` serves `full_name % $1`; gender and the
      // date range are recheck filters on what the trigram match returns.
      collect(
        await tx.rows<{ id: string }>(
          `SELECT id FROM patient.patients
            WHERE full_name % $1
              AND gender = $2::patient."PatientGender"
              AND dob BETWEEN ($3::date - INTERVAL '366 days') AND ($3::date + INTERVAL '366 days')
              AND status = 'active' AND deleted_at IS NULL
            LIMIT ${CANDIDATE_LIMIT}`,
          [input.fullName, input.gender, input.dob],
        ),
      );
    }

    if (ids.size === 0) return [];

    const rows = await tx.rows<CandidateRow>(
      `SELECT p.id, p.uhid, p.full_name, p.gender::text AS gender, p.dob::text AS dob_text,
              p.age_years, p.mobile, p.abha_number, p.abha_address, p.dedupe_fingerprint,
              p.aadhaar_hash, p.last_visit_at, p.status::text AS status,
              similarity(p.full_name, $2) AS name_similarity
         FROM patient.patients p
        WHERE p.id = ANY($1::uuid[])`,
      [[...ids], input.fullName],
    );

    const abhaDigitsWanted = new Set(input.abhaNumberVariants.map((v) => v.replace(/[^0-9]/g, '')));

    const scored = rows.map((row): DuplicateCandidate => {
      const score = scoreDuplicate({
        abhaNumberMatch:
          row.abha_number !== null && abhaDigitsWanted.has(row.abha_number.replace(/[^0-9]/g, '')),
        abhaAddressMatch: input.abhaAddress !== null && row.abha_address === input.abhaAddress,
        aadhaarHashMatch:
          input.aadhaarHash !== null &&
          row.aadhaar_hash !== null &&
          input.aadhaarHash.equals(row.aadhaar_hash),
        fingerprintMatch: row.dedupe_fingerprint === input.fingerprint,
        mobileMatch: row.mobile === input.mobileE164,
        dobExactMatch: input.dob !== null && row.dob_text === input.dob,
        dobWithinOneYear: dobWithinOneYear(input.dob, row.dob_text),
        genderMatch: row.gender === input.gender,
        nameSimilarity: Number(row.name_similarity),
      });

      return {
        patientId: row.id,
        uhid: row.uhid,
        fullName: row.full_name,
        gender: row.gender,
        dob: row.dob_text,
        ageYears: row.age_years,
        lastVisitAt: row.last_visit_at,
        status: row.status,
        score: score.score,
        ruleHits: score.ruleHits,
      };
    });

    return scored.filter((c) => c.score > 0).sort((a, b) => b.score - a.score);
  }

  /**
   * Files the pair in the MRD dedupe queue (OP-001 §3.8).
   *
   * The pair is stored in one canonical order — the `dedupe_candidates_ordered_pair`
   * CHECK insists on `patient_a_id < patient_b_id` — so (A,B) and (B,A) cannot
   * both sit open in the queue and be reviewed twice to opposite conclusions.
   *
   * Re-registering against the same pair raises the score rather than inserting a
   * second row, and never re-opens a pair an officer has already decided is not a
   * duplicate: overturning that decision is a review, not a side effect of
   * somebody typing the name again.
   */
  async recordCandidate(
    tx: TransactionClient,
    newPatientId: string,
    candidate: DuplicateCandidate,
    detectedBy: string,
  ): Promise<void> {
    const ctx = getContext();
    const [a, b] =
      newPatientId < candidate.patientId
        ? [newPatientId, candidate.patientId]
        : [candidate.patientId, newPatientId];

    await tx.query(
      `INSERT INTO patient.dedupe_candidates
         (id, hospital_id, patient_a_id, patient_b_id, score, rule_hits, detected_by, status,
          created_by, updated_at)
       VALUES ($1, $2, $3, $4, $5::numeric, $6::jsonb, $7, 'open', $8, now())
       ON CONFLICT (hospital_id, patient_a_id, patient_b_id) DO UPDATE
          SET score      = GREATEST(patient.dedupe_candidates.score, EXCLUDED.score),
              rule_hits  = EXCLUDED.rule_hits,
              updated_at = now(),
              version    = patient.dedupe_candidates.version + 1
        WHERE patient.dedupe_candidates.status = 'open'`,
      [
        newId(),
        ctx.hospitalId,
        a,
        b,
        candidate.score.toFixed(3),
        JSON.stringify({ rules: candidate.ruleHits }),
        detectedBy,
        ctx.userId,
      ],
    );
  }
}
