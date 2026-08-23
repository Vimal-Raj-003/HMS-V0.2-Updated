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
 *   USERNAME       default labtech@vims-blr
 *   PASSWORD       default VimsDev#2026
 *   DAILY_RESULTS  default 20000  — the gate's number
 *   BATCH          default 8      — result lines per POST, i.e. a panel
 *   DURATION       default 10m    — the window the day is compressed into
 *
 * Every endpoint is measured and gated **separately**, against the class
 * `docs/07 §2.1` assigns it. An aggregate p95 across a worklist read and an
 * authorisation would let a slow compound write hide behind a fast cached
 * lookup, which is the whole reason the document has classes at all.
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const HOSPITAL_ID = __ENV.HOSPITAL_ID;
const USERNAME = __ENV.USERNAME || 'labtech@vims-blr';
const PASSWORD = __ENV.PASSWORD || 'VimsDev#2026';

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
    http_req_failed: ['rate<0.001'],
    lab_catalogue: gate('catalogue', CLASS.A),
    lab_worklist: gate('worklist', CLASS.B),
    lab_critical_list: gate('critical_list', CLASS.B),
    lab_qc_state: gate('qc_state', CLASS.B),
    rad_reading_worklist: gate('rad_worklist', CLASS.B),
    lab_patient_results: gate('patient_results', CLASS.C),
    lab_order_create: gate('order_create', CLASS.D),
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
  const login = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ hospitalId: HOSPITAL_ID, identifier: USERNAME, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (login.status !== 200 && login.status !== 201) {
    fail(`login failed (${login.status}). Has the volume seed been run against this database?`);
  }
  const token = login.json('accessToken');
  if (!token) fail('login returned no accessToken');

  const headers = authHeaders(token);

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

  return { token, tests, patientIds };
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
  const headers = authHeaders(data.token, { 'idempotency-key': `k6-lab-${__VU}-${__ITER}` });

  const order = http.post(
    `${BASE_URL}/lab/orders`,
    JSON.stringify({
      patientId: pick(data.patientIds, i),
      source: 'opd',
      priority: 'routine',
      tests: Array.from({ length: BATCH }, (_, k) => ({ testKey: pick(data.tests, i + k) })),
    }),
    { headers, tags: { step: 'order_create' } },
  );
  t.order_create.add(order.timings.duration);
  if (!check(order, { 'order created': (r) => r.status === 200 || r.status === 201 })) return;

  const orderId = order.json('id');
  const orderTests = order.json('tests') || [];
  if (orderTests.length === 0) return;

  const entry = http.post(
    `${BASE_URL}/lab/results`,
    JSON.stringify({
      results: orderTests.map((ot, k) => ({
        orderTestId: ot.id,
        resultType: 'numeric',
        // Deterministic and mostly in range, with every 20th line pushed out of
        // range so the flagging path — and its index — is exercised rather than
        // measured only on the happy case.
        valueNumeric: (i + k) % 20 === 0 ? 9.9 : 4.2,
        unit: 'mmol/L',
      })),
    }),
    {
      headers: authHeaders(data.token, { 'idempotency-key': `k6-enter-${__VU}-${__ITER}` }),
      tags: { step: 'result_enter' },
    },
  );
  t.result_enter.add(entry.timings.duration);
  if (!check(entry, { 'results entered': (r) => r.status === 200 || r.status === 201 })) return;

  const resultIds = (entry.json('results') || []).map((r) => r.id).filter(Boolean);
  if (resultIds.length === 0) return;

  const verified = http.post(
    `${BASE_URL}/lab/results/verify`,
    JSON.stringify({ resultIds, signMethod: 'system' }),
    {
      headers: authHeaders(data.token, { 'idempotency-key': `k6-verify-${__VU}-${__ITER}` }),
      tags: { step: 'result_verify' },
    },
  );
  t.result_verify.add(verified.timings.duration);
  if (!check(verified, { 'results verified': (r) => r.status === 200 || r.status === 201 })) return;

  const authorised = http.post(
    `${BASE_URL}/lab/results/authorise`,
    JSON.stringify({ resultIds, signMethod: 'system' }),
    {
      headers: authHeaders(data.token, { 'idempotency-key': `k6-auth-${__VU}-${__ITER}` }),
      tags: { step: 'result_authorise' },
    },
  );
  t.result_authorise.add(authorised.timings.duration);
  // Not checked as a hard failure: a batch carrying the out-of-range line is
  // *correctly* refused until its critical call-back is documented (D-10). A
  // test that treated that refusal as an error would push whoever ran it toward
  // weakening the one safety property this phase is built on.
  check(authorised, {
    'authorise answered': (r) => r.status === 200 || r.status === 201 || r.status === 409 || r.status === 422,
  });

  if (orderId) {
    const report = http.post(
      `${BASE_URL}/lab/reports/${orderId}/generate`,
      JSON.stringify({ type: 'final' }),
      {
        headers: authHeaders(data.token, { 'idempotency-key': `k6-report-${__VU}-${__ITER}` }),
        tags: { step: 'report_enqueue' },
      },
    );
    t.report_enqueue.add(report.timings.duration);
    check(report, {
      'report answered': (r) => r.status === 200 || r.status === 201 || r.status === 409 || r.status === 422,
    });
  }
}

/** The read path, running concurrently — a lab is never only writing. */
export function reading(data) {
  const headers = authHeaders(data.token);
  const i = __ITER + __VU;

  const cases = [
    ['catalogue', `${BASE_URL}/lab/catalogue/tests?limit=25`],
    ['worklist', `${BASE_URL}/lab/worklists/bench?discipline=biochemistry&stage=pending&limit=25`],
    ['critical_list', `${BASE_URL}/lab/critical-values?limit=25`],
    ['qc_state', `${BASE_URL}/lab/qc/state`],
    ['rad_worklist', `${BASE_URL}/rad/reading-worklist?limit=25`],
    ['patient_results', `${BASE_URL}/lab/patients/${pick(data.patientIds, i)}/results?limit=25`],
  ];

  for (const [mode, url] of cases) {
    const res = http.get(url, { headers, tags: { mode } });
    t[mode].add(res.timings.duration);
    check(res, { [`${mode}: 200`]: (r) => r.status === 200 });
  }
}
