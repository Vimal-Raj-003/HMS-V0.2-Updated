# ADR-0006 — Orthanc + OHIF for PACS rather than a commercial PACS or a self-built archive

**Status:** Accepted · 2026-08-17

## Context
Radiology needs a DICOM archive (C-STORE/C-FIND/MWL/MPPS/WADO-RS) and a zero-footprint viewer, on-prem and cloud,
without a per-study licence that destroys the price position.

## Decision
Orthanc as the archive (with the S3/object-storage plugin for tiering) and OHIF embedded as the viewer, integrated
through EN-008. Commercial PACS remains supportable through the same DICOM interfaces where a hospital already owns one.

## Consequences
- No per-study licensing; on-prem friendly; well-proven in production elsewhere.
- We own the operational burden (storage tiering, retention, performance tuning) — covered in `docs/10`.
- Advanced 3D/AI reading is out of scope; AI-007 integrates cleared third-party engines instead.
