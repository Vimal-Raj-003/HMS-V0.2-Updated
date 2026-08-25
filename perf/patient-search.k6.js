/**
 * Patient search under load — `docs/07 §2.1` class F, `docs/09 §7` merge gate.
 *
 * Run against the **volume seed**, never an empty database. A search that is
 * fast on 40 rows is fast because there is nothing to search; running this on an
 * empty database is the classic way to ship a missing index and `docs/09 §7`
 * says so explicitly.
 *
 *   pnpm seed:volume
 *   k6 run perf/patient-search.k6.js
 *
 * Environment:
 *   BASE_URL      default http://localhost:4000/api/v1
 *   HOSPITAL_ID   required — the tenant to search within
 *   LOGIN_USERNAME      default receptionist@vims-blr
 *   LOGIN_PASSWORD      default VimsDev#2026
 *
 * Each search mode is measured separately and gated separately, because they
 * take different code paths to different indexes: an exact-mobile lookup that
 * stays fast can hide a name search that has fallen back to a sequential scan,
 * and an aggregate p95 across all five would let it.
 *
 * **The credential variables are `LOGIN_USERNAME` / `LOGIN_PASSWORD`, not
 * `USERNAME` / `PASSWORD`.** `USERNAME` is a *special parameter* in zsh, bound
 * to the current user, and an inline `USERNAME=x k6 run ...` does not override
 * it — k6 receives the shell's value. This cost a debugging session: the script
 * sent `"identifier":"vims"`, the API answered 401, and the account it named was
 * perfectly valid when tested with curl.
 */
import http from 'k6/http';
import { check, fail } from 'k6';
import { Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000/api/v1';
const HOSPITAL_ID = __ENV.HOSPITAL_ID;
const USERNAME = __ENV.LOGIN_USERNAME || 'receptionist@vims-blr';
const PASSWORD = __ENV.LOGIN_PASSWORD || 'VimsDev#2026';

/**
 * `docs/07 §2.1`: patient search is class F — "full-text / fuzzy search" —
 * budgeted at p50 90 ms, p95 400 ms, p99 800 ms.
 *
 * Note this is *not* the 200 ms in `CLAUDE.md §6`. `docs/07 §93` refines that
 * figure as the weighted median of classes A–D; F carries the higher budget
 * deliberately, because fuzzy matching over a large table cannot be made to
 * behave like a primary-key lookup.
 */
const P95_BUDGET_MS = 400;
const P50_BUDGET_MS = 90;

const byMode = {
  mobile_exact: new Trend('search_mobile_exact', true),
  mobile_prefix: new Trend('search_mobile_prefix', true),
  uhid_prefix: new Trend('search_uhid_prefix', true),
  name: new Trend('search_name', true),
  identifier: new Trend('search_identifier', true),
};

export const options = {
  scenarios: {
    // A busy front office: several counters searching continuously. `docs/09 §7`
    // budgets three minutes for the per-PR smoke.
    front_office: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 10),
      duration: __ENV.DURATION || '3m',
      gracefulStop: '10s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],
    // Gate each mode independently — see the file header.
    search_mobile_exact: [`p(95)<${P95_BUDGET_MS}`, `p(50)<${P50_BUDGET_MS}`],
    search_mobile_prefix: [`p(95)<${P95_BUDGET_MS}`, `p(50)<${P50_BUDGET_MS}`],
    search_uhid_prefix: [`p(95)<${P95_BUDGET_MS}`, `p(50)<${P50_BUDGET_MS}`],
    search_name: [`p(95)<${P95_BUDGET_MS}`, `p(50)<${P50_BUDGET_MS}`],
    search_identifier: [`p(95)<${P95_BUDGET_MS}`, `p(50)<${P50_BUDGET_MS}`],
  },
};

export function setup() {
  if (!HOSPITAL_ID) {
    fail('HOSPITAL_ID is required. Find it with: SELECT hospital_id FROM core.users WHERE username = ...');
  }
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ hospitalId: HOSPITAL_ID, identifier: USERNAME, password: PASSWORD }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (res.status !== 201 && res.status !== 200) {
    fail(`login failed (${res.status}). Has the volume seed been run against this database?`);
  }
  const token = res.json('accessToken');
  if (!token) fail('login returned no accessToken');

  // Sample real values from the seeded data. Searching for terms that match
  // nothing measures how fast the database says "no", which is the one case
  // that is always quick and tells you nothing about the index.
  const sample = http.get(`${BASE_URL}/patients?limit=50`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (sample.status !== 200) fail(`could not sample patients (${sample.status})`);
  const items = sample.json('items') || [];
  if (items.length === 0) fail('no patients found — run `pnpm seed:volume` first');

  return {
    token,
    mobiles: items.map((p) => p.mobile).filter(Boolean),
    uhids: items.map((p) => p.uhid).filter(Boolean),
    names: items.map((p) => p.full_name).filter(Boolean),
  };
}

function pick(list, iteration) {
  // Deterministic rotation rather than random: a failed run should be
  // reproducible, and k6 gives every VU its own __ITER.
  return list[iteration % list.length];
}

export default function (data) {
  const headers = { authorization: `Bearer ${data.token}` };
  const i = __ITER + __VU;

  const mobile = pick(data.mobiles, i);
  const uhid = pick(data.uhids, i);
  const name = pick(data.names, i);

  const cases = [
    ['mobile_exact', `${BASE_URL}/patients?mobile=${encodeURIComponent(mobile)}`],
    ['mobile_prefix', `${BASE_URL}/patients?q=${encodeURIComponent(String(mobile).slice(0, 7))}`],
    ['uhid_prefix', `${BASE_URL}/patients?uhid=${encodeURIComponent(String(uhid).slice(0, 9))}`],
    // A surname, which is what a receptionist actually types.
    ['name', `${BASE_URL}/patients?q=${encodeURIComponent(String(name).split(' ').pop())}`],
    ['identifier', `${BASE_URL}/patients?identifier=${encodeURIComponent(String(uhid).slice(0, 6))}`],
  ];

  for (const [mode, url] of cases) {
    const res = http.get(url, { headers, tags: { mode } });
    byMode[mode].add(res.timings.duration);
    check(res, {
      [`${mode}: 200`]: (r) => r.status === 200,
      [`${mode}: returned a page`]: (r) => Array.isArray(r.json('items')),
    });
  }
}
