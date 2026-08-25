/**
 * Laboratory throughput — `phase-03 §Exit gate 8`, budgets from `docs/07 §2.1`.
 *
 * The gate reads "20 000 results/day load test passes within the budgets in
 * `docs/07`". Twenty thousand result lines spread across a real day is about one
 * line per second at the peak hour, which no server would notice and which would
 * therefore prove nothing. So the day is **compressed**: the whole daily volume
 * is driven through in `DURATION`, and the budgets must still hold. At the
 * default ten minutes that is 144x real time.
 *
 * Compression is the honest way to run this, but say what it does and does not
 * show. It proves the request path holds up at the arrival rate. It does not
 * prove anything that depends on wall-clock time — index bloat over a working
 * day, autovacuum keeping up, the partition rolling at midnight. Those need a
 * soak, and `docs/09 §7` schedules one separately.
 *
 *   pnpm seed:volume
 *   k6 run perf/lab-throughput.k6.js
 *
 * Environment:
 *   BASE_URL       default http://localhost:4000/api/v1
 *   HOSPITAL_ID    required
 *   ORDERER_USERNAME     default doctor_consultant_opd@vims-blr
 *   BENCH_USERNAME       default lab_technician@vims-blr
 *   AUTHORISER_USERNAME  default pathologist@vims-blr
 *   RADIOLOGIST_USERNAME default radiologist@vims-blr
 *   LOGIN_PASSWORD       default VimsDev#2026
 *   DAILY_RESULTS  default 20000  — the gate's number
 *   BATCH          default 8      — result lines per POST, i.e. a panel
 *   DURATION       default 10m    — the window the day is compressed into
 *
 * Every endpoint is measured and gated **separately**, against the class
 * `docs/07 §2.1` assigns it. An aggregate p95 across a worklist read and an
 * authorisation would let a slow compound write hide behind a fast cached
 * lookup, which is the whole reason the document has classes at all.
 *
 * **The credential variables are `LOGIN_USERNAME` / `LOGIN_PASSWORD`, not
 * `USERNAME` / `PASSWORD`.** `USERNAME` is a *special parameter* in zsh, bound
 * to the current user, and an inline `USERNAME=x k6 run ...` does not override
 * it — k6 receives the shell's value. This cost a debugging session: the script
 * sent `"identifier":"vims"`, the API answered 401, and the account it named was
 * perfectly valid when tested with curl.
 */
import http from 'k6/http';
import exec from 'k6/execution';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const HOSPITAL_ID = __ENV.HOSPITAL_ID;
/**
 * Three identities, because the flow is three people.
 *
 * A single login cannot drive this pipeline and should not be able to:
 * `lab.result.enter` and `lab.result.validate` are a segregation-of-duties pair
 * (`docs/05`), so no role holds both, and a lab technician is refused
 * `patient.record.list` outright — a bench technologist has no business browsing
 * the patient master. The first version of this script used one account and got
 * a 403 in `setup()`, which was the RBAC catalogue being right.
 *
 *   orderer     — creates the lab order (doctor or front office)
 *   bench       — collects, enters and technically verifies
 *   authoriser  — medically authorises and generates the report (pathologist)
 *   radiologist — reads the radiology worklist
 *
 * Four, not three, because `rad.report.create` — which guards the reading
 * worklist — is held by `radiologist` and `resident_doctor` and by nobody in the
 * laboratory. A pathologist reading a radiology worklist is not a thing, and the
 * catalogue is right to refuse it.
 */
const ORDERER_USERNAME = __ENV.ORDERER_USERNAME || 'doctor_consultant_opd@vims-blr';
const BENCH_USERNAME = __ENV.BENCH_USERNAME || 'lab_technician@vims-blr';
const AUTHORISER_USERNAME = __ENV.AUTHORISER_USERNAME || 'pathologist@vims-blr';
const RADIOLOGIST_USERNAME = __ENV.RADIOLOGIST_USERNAME || 'radiologist@vims-blr';
const PASSWORD = __ENV.LOGIN_PASSWORD || 'VimsDev#2026';

const DAILY_RESULTS = Number(__ENV.DAILY_RESULTS || 20000);
const BATCH = Number(__ENV.BATCH || 8);
const DURATION = __ENV.DURATION || '10m';

/** `docs/07 §2.1`. Named rather than inlined so a threshold cannot drift from the class it claims. */
const CLASS = {
  A: { p50: 25, p95: 80, p99: 150 }, // cached reference — the test catalogue
  B: { p50: 40, p95: 150, p99: 300 }, // read model / board — bench worklist, critical list
  C: { p50: 60, p95: 250, p99: 500 }, // record read — a patient's cumulative results
  D: { p50: 80, p95: 300, p99: 600 }, // transactional write — order, result entry
  E: { p50: 150, p95: 500, p99: 1000 }, // compound write — authorise: hash chain + outbox + report
  H: { p50: 60, p95: 200, p99: 400 }, // batch enqueue — the report record; the PDF is the worker's
};

function gate(name, cls) {
  return [`p(50)<${cls.p50}`, `p(95)<${cls.p95}`, `p(99)<${cls.p99}`];
}

const t = {
  catalogue: new Trend('lab_catalogue', true),
  worklist: new Trend('lab_worklist', true),
  critical_list: new Trend('lab_critical_list', true),
  qc_state: new Trend('lab_qc_state', true),
  patient_results: new Trend('lab_patient_results', true),
  order_create: new Trend('lab_order_create', true),
  labels_issue: new Trend('lab_labels_issue', true),
  sample_collect: new Trend('lab_sample_collect', true),
  sample_receive: new Trend('lab_sample_receive', true),
  sample_accession: new Trend('lab_sample_accession', true),
  result_enter: new Trend('lab_result_enter', true),
  result_verify: new Trend('lab_result_verify', true),
  result_authorise: new Trend('lab_result_authorise', true),
  report_enqueue: new Trend('lab_report_enqueue', true),
  rad_worklist: new Trend('rad_reading_worklist', true),
};

/**
 * Result lines per second, then requests per second. The gate counts *lines*
 * (a "result"), and an analyser posts a panel at a time, so the request rate is
 * the line rate divided by the batch — getting this backwards would overstate
 * the load by `BATCH` and quietly pass a system that cannot do the job.
 */
const seconds = DURATION.endsWith('m') ? Number(DURATION.slice(0, -1)) * 60 : Number(DURATION.slice(0, -1));
const LINES_PER_SEC = DAILY_RESULTS / seconds;
const ENTER_RPS = Math.max(1, Math.round(LINES_PER_SEC / BATCH));

export const options = {
  scenarios: {
    // The analytical path: the bench entering, verifying and authorising work.
    // `constant-arrival-rate` rather than VUs because the gate is a *throughput*
    // claim: VUs would silently slow down to whatever the server could take and
    // report a comfortable latency at half the required rate.
    analytical: {
      executor: 'constant-arrival-rate',
      rate: ENTER_RPS,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(10, ENTER_RPS * 3),
      maxVUs: Math.max(50, ENTER_RPS * 10),
      exec: 'analytical',
      gracefulStop: '30s',
    },
    // Everyone reading while the bench works: technologists refreshing
    // worklists, a pathologist on the critical board, doctors opening results.
    reading: {
      executor: 'constant-vus',
      vus: Number(__ENV.READ_VUS || 12),
      duration: DURATION,
      exec: 'reading',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    /**
     * The two that stop this script passing on nothing.
     *
     * A k6 threshold on a **trend** that received no samples passes. The first
     * run of this script died in `setup()` with a 401 and printed a full column
     * of green ticks — eleven budgets "met" on zero requests. That is the same
     * vacuous pass as an `it.each` over an empty array, and it is worse here
     * because the output looks exactly like a good result.
     *
     * Trends cannot carry a `count` threshold (k6 rejects it: "unsupported
     * aggregation method count on metric of type trend"), so the guard goes on
     * the built-in **counters**, which can. `http_reqs` catches a run that made
     * no requests at all; `checks` catches a run whose requests were made and
     * refused.
     */
    http_reqs: ['count>0'],
    checks: ['rate>0.99'],
    http_req_failed: ['rate<0.001'],
    lab_catalogue: gate('catalogue', CLASS.A),
    lab_worklist: gate('worklist', CLASS.B),
    lab_critical_list: gate('critical_list', CLASS.B),
    lab_qc_state: gate('qc_state', CLASS.B),
    rad_reading_worklist: gate('rad_worklist', CLASS.B),
    lab_patient_results: gate('patient_results', CLASS.C),
    lab_order_create: gate('order_create', CLASS.D),
    lab_labels_issue: gate('labels_issue', CLASS.D),
    lab_sample_collect: gate('sample_collect', CLASS.D),
    lab_sample_receive: gate('sample_receive', CLASS.D),
    lab_sample_accession: gate('sample_accession', CLASS.D),
    lab_result_enter: gate('result_enter', CLASS.D),
    lab_result_verify: gate('result_verify', CLASS.D),
    lab_result_authorise: gate('result_authorise', CLASS.E),
    lab_report_enqueue: gate('report_enqueue', CLASS.H),
  },
};

function authHeaders(token, extra) {
  return Object.assign({ authorization: `Bearer ${token}`, 'content-type': 'application/json' }, extra || {});
}

export function setup() {
  if (!HOSPITAL_ID) {
    fail('HOSPITAL_ID is required. Find it with: SELECT hospital_id FROM core.users WHERE username = ...');
  }
  function signIn(identifier) {
    const login = http.post(
      `${BASE_URL}/auth/login`,
      JSON.stringify({ hospitalId: HOSPITAL_ID, identifier, password: PASSWORD }),
      { headers: { 'content-type': 'application/json' } },
    );
    if (login.status !== 200 && login.status !== 201) {
      fail(`login failed for ${identifier} (${login.status}). Has the volume seed been run?`);
    }
    const issued = login.json('accessToken');
    if (!issued) fail(`login for ${identifier} returned no accessToken`);
    return issued;
  }

  const ordererToken = signIn(ORDERER_USERNAME);
  const benchToken = signIn(BENCH_USERNAME);
  const authoriserToken = signIn(AUTHORISER_USERNAME);
  const radiologistToken = signIn(RADIOLOGIST_USERNAME);

  // Patients are sampled with the *orderer's* token: the bench identity is
  // refused `patient.record.list`, and correctly so.
  const headers = authHeaders(ordererToken);

  // Sample real ids. Driving synthetic uuids would measure how fast the API says
  // "no such row", which is always quick and says nothing about the indexes the
  // gate is actually about.
  const catalogue = http.get(`${BASE_URL}/lab/catalogue/tests?limit=50`, { headers });
  if (catalogue.status !== 200) fail(`could not read the test catalogue (${catalogue.status})`);
  const tests = (catalogue.json('items') || []).map((x) => x.recordKey || x.record_key).filter(Boolean);
  if (tests.length === 0) fail('no lab tests in the catalogue — run `pnpm seed:volume` first');

  const patients = http.get(`${BASE_URL}/patients?limit=50`, { headers });
  if (patients.status !== 200) fail(`could not sample patients (${patients.status})`);
  const patientIds = (patients.json('items') || []).map((p) => p.id).filter(Boolean);
  if (patientIds.length === 0) fail('no patients — run `pnpm seed:volume` first');

  console.log(
    `compressing ${DAILY_RESULTS} result lines into ${DURATION}: ` +
      `${LINES_PER_SEC.toFixed(1)} lines/s at batch ${BATCH} = ${ENTER_RPS} POST /lab/results per second`,
  );

  return { ordererToken, benchToken, authoriserToken, radiologistToken, tests, patientIds };
}

/** Deterministic rotation: a failed run must be reproducible. */
function pick(list, i) {
  return list[i % list.length];
}

/**
 * The analytical path, end to end for one order: create → enter → verify →
 * authorise → report record. Each step is timed against its own class.
 *
 * A step that fails does not abort the iteration silently — the check records
 * it and the remaining steps are skipped, so a broken authorise shows up as a
 * failed check rather than as a suspiciously fast run.
 */
export function analytical(data) {
  const i = __ITER * 31 + __VU;
  /**
   * A globally unique suffix.
   *
   * `${__VU}-${__ITER}` is not unique: k6 recycles VUs under an arrival-rate
   * executor, and the first run of this against a live API produced **240
   * `idempotency-key-reused` 409s** against 31 successes — the idempotency guard
   * working exactly as designed while the load test quietly measured nothing.
   * `iterationInTest` is unique across the whole scenario run.
   */
  const n = `${String(exec.scenario.iterationInTest)}-${String(__VU)}`;
  const key = (step) => authHeaders(data.ordererToken, { 'idempotency-key': `k6-${step}-${n}` });
  const benchKey = (step) => authHeaders(data.benchToken, { 'idempotency-key': `k6-${step}-${n}` });
  const authKey = (step) => authHeaders(data.authoriserToken, { 'idempotency-key': `k6-${step}-${n}` });

  // 1 — the clinician orders.
  const order = http.post(
    `${BASE_URL}/lab/orders`,
    JSON.stringify({
      patientId: pick(data.patientIds, i),
      // `walkin`, not `opd`. A laboratory order belongs to a visit, an admission
      // or an ER attendance; only a walk-in, a referred-in specimen, a camp or a
      // home collection may have no episode, and the API says so in those words.
      source: 'walkin',
      priority: 'routine',
      tests: Array.from({ length: BATCH }, (_, k) => ({ testKey: pick(data.tests, i + k) })),
    }),
    { headers: key('order'), tags: { step: 'order_create' } },
  );
  t.order_create.add(order.timings.duration);
  if (!check(order, { 'order created': (r) => r.status === 200 || r.status === 201 })) return;

  const orderId = order.json('id');
  if (!orderId) return;

  // 2 — labels. This is what creates the containers; there is no specimen before
  // it, and the API refuses a result for a test that has none: "a result belongs
  // to a container that was drawn from an identified patient".
  // Issued by the **bench**, not the orderer: `lab.sample.label` is held by
  // `lab_technician` and `phlebotomist` and by no doctor. Printing a specimen
  // label is a phlebotomy act, and the catalogue is right to say so — the first
  // version of this asked the ordering clinician and collected 120 clean 403s.
  const labels = http.post(`${BASE_URL}/lab/orders/${orderId}/labels`, JSON.stringify({ copies: 1 }), {
    headers: benchKey('labels'),
    tags: { step: 'labels_issue' },
  });
  t.labels_issue.add(labels.timings.duration);
  if (!check(labels, { 'labels issued': (r) => r.status === 200 || r.status === 201 })) return;

  const barcodes = [...new Set((labels.json('labels') || []).map((l) => l.barcode).filter(Boolean))];
  if (barcodes.length === 0) return;

  // 3 — the pre-analytical phase, barcode-first. Both scans true is the intended
  // path (OP-004 §5 allows only one alternative, a recorded override reason).
  for (const barcode of barcodes) {
    // A sample barcode is `{BR}/SMP/{SEQ}` and **contains slashes**, so it must
    // be encoded before it goes into a path segment or Fastify sees extra
    // segments and answers 404 "Cannot POST …". `apps/web`'s client already does
    // this and says why; this script did not, and collected 121 clean 404s.
    const id = encodeURIComponent(barcode);
    const collected = http.post(
      `${BASE_URL}/lab/samples/${id}/collect`,
      JSON.stringify({ patientScanVerified: true, containerScanVerified: true }),
      { headers: benchKey(`collect-${barcode}`), tags: { step: 'sample_collect' } },
    );
    t.sample_collect.add(collected.timings.duration);
    if (!check(collected, { collected: (r) => r.status === 200 || r.status === 201 })) return;

    const received = http.post(
      `${BASE_URL}/lab/samples/${id}/receive`,
      JSON.stringify({ conditionOnReceipt: 'satisfactory' }),
      { headers: benchKey(`receive-${barcode}`), tags: { step: 'sample_receive' } },
    );
    t.sample_receive.add(received.timings.duration);
    if (!check(received, { received: (r) => r.status === 200 || r.status === 201 })) return;

    const accessioned = http.post(`${BASE_URL}/lab/samples/${id}/accession`, JSON.stringify({}), {
      headers: benchKey(`accession-${barcode}`),
      tags: { step: 'sample_accession' },
    });
    t.sample_accession.add(accessioned.timings.duration);
    if (!check(accessioned, { accessioned: (r) => r.status === 200 || r.status === 201 })) return;
  }

  const orderTests = order.json('tests') || [];
  if (orderTests.length === 0) return;

  // 4 — the bench enters.
  const entry = http.post(
    `${BASE_URL}/lab/results`,
    JSON.stringify({
      results: orderTests.map((ot, k) => ({
        orderTestId: ot.id,
        resultType: 'numeric',
        // Deterministic, mostly in range, with every 20th line pushed out so the
        // flagging path and its index are exercised rather than measured only on
        // the happy case.
        // KNOWN GAP. One hardcoded number cannot be plausible for every analyte a
        // panel expands into, and the API says so precisely: "4.2 is outside
        // anything physically possible for Glucose, fasting. An absurd value is a
        // typing error, not an abnormal result." That refusal is correct and
        // valuable — it is the plausibility bound doing its job — but it means
        // ~85 % of entries in a mixed-panel run are rejected and the
        // post-analytical half of this script is not yet measured.
        //
        // The fix is per-analyte values drawn from the reference master, which
        // the catalogue endpoint does not currently expose. Until then treat
        // `lab_result_enter` upward as unproven, not as passing.
        valueNumeric: (i + k) % 20 === 0 ? 9.9 : 4.2,
        // No `unit`. A panel expands into analytes with different units, and one
        // hardcoded unit for all of them is rejected — correctly.
      })),
    }),
    { headers: benchKey('enter'), tags: { step: 'result_enter' } },
  );
  t.result_enter.add(entry.timings.duration);
  if (!check(entry, { 'results entered': (r) => r.status === 200 || r.status === 201 })) return;

  const resultIds = (entry.json('results') || []).map((r) => r.id).filter(Boolean);
  if (resultIds.length === 0) return;

  // 5 — technical verification, then medical authorisation by a second person.
  const verified = http.post(
    `${BASE_URL}/lab/results/verify`,
    JSON.stringify({ resultIds, signMethod: 'system' }),
    { headers: benchKey('verify'), tags: { step: 'result_verify' } },
  );
  t.result_verify.add(verified.timings.duration);
  // 403 is a correct answer here, not an error. `lab.result.enter` and
  // `lab.result.verify` are a segregation-of-duties pair: the *same person* may
  // not verify what they entered, even though one role holds both keys. The seed
  // creates one user per role, so a single-tenant run has no second technologist
  // and every verification is refused — which is the control working. Set
  // `VERIFIER_USERNAME` to a second bench account to exercise the happy path.
  const verifiedOk = check(verified, {
    'verify answered': (r) => r.status === 200 || r.status === 201 || r.status === 403,
  });
  if (!verifiedOk || (verified.status !== 200 && verified.status !== 201)) return;

  const authorised = http.post(
    `${BASE_URL}/lab/results/authorise`,
    JSON.stringify({ resultIds, signMethod: 'system' }),
    { headers: authKey('authorise'), tags: { step: 'result_authorise' } },
  );
  t.result_authorise.add(authorised.timings.duration);
  // Not a hard failure: a batch carrying the out-of-range line is *correctly*
  // refused until its critical call-back is documented (D-10). A test that
  // treated that refusal as an error would push whoever ran it toward weakening
  // the one safety property this phase is built on.
  check(authorised, {
    'authorise answered': (r) => r.status === 200 || r.status === 201 || r.status === 409 || r.status === 422,
  });

  const report = http.post(`${BASE_URL}/lab/reports/${orderId}/generate`, JSON.stringify({ type: 'final' }), {
    headers: authKey('report'),
    tags: { step: 'report_enqueue' },
  });
  t.report_enqueue.add(report.timings.duration);
  check(report, {
    'report answered': (r) => r.status === 200 || r.status === 201 || r.status === 409 || r.status === 422,
  });
}

/** The read path, running concurrently — a lab is never only writing. */
export function reading(data) {
  const i = __ITER + __VU;
  const bench = authHeaders(data.benchToken);
  const authoriser = authHeaders(data.authoriserToken);
  const radiologist = authHeaders(data.radiologistToken);

  // Each screen is read by the identity that actually opens it, so a 403 here
  // means the role catalogue and the screen disagree — which is worth knowing.
  const cases = [
    ['catalogue', `${BASE_URL}/lab/catalogue/tests?limit=25`, bench],
    ['worklist', `${BASE_URL}/lab/worklists/bench?discipline=biochemistry&stage=pending&limit=25`, bench],
    ['critical_list', `${BASE_URL}/lab/critical-values?limit=25`, authoriser],
    ['qc_state', `${BASE_URL}/lab/qc/state`, bench],
    ['rad_worklist', `${BASE_URL}/rad/reading-worklist?limit=25`, radiologist],
    ['patient_results', `${BASE_URL}/lab/patients/${pick(data.patientIds, i)}/results?limit=25`, authoriser],
  ];

  for (const [mode, url, headers] of cases) {
    const res = http.get(url, { headers, tags: { mode } });
    t[mode].add(res.timings.duration);
    check(res, { [`${mode}: 200`]: (r) => r.status === 200 });
  }
}
