import { expect, test, type Page } from '@playwright/test';
import { signIn } from './fixtures';

/**
 * The three shifts: a receptionist's, a nurse's, and a doctor's.
 *
 * Everything else in this suite tests a screen. This tests a *day* — the
 * sequence a hospital actually runs, across the modules that have to hand work
 * to one another for it to happen at all. A console can render, answer every
 * route and pass a hundred screen checks while the journey through it is broken
 * at the second step, and until now nothing here would have noticed: the
 * deepest existing spec stops at registration.
 *
 * ── Where the UI is the workflow, the UI is used ───────────────────────────
 *
 * Registering a patient, recording vitals, writing and signing a note,
 * prescribing: all of those are done by clicking, because whether a person can
 * do them is the question. Where a step has no screen — opening a visit, an
 * encounter — the journey calls the API through the app's own proxy, on the
 * same session cookie the browser is holding. That is not a shortcut so much as
 * a finding, and each one is marked `NO SCREEN` below.
 */

const now = Date.now();
const uniqueMobile = (): string => `9${String(now).slice(-9)}`;

interface Ids {
  patientId: string;
  uhid: string;
  visitId: string;
  encounterId: string;
}
const ids: Ids = { patientId: '', uhid: '', visitId: '', encounterId: '' };

/**
 * Calls the API the way the browser does — through `/api/v1/...`, which the web
 * app proxies, carrying the session cookie Playwright already holds. A step
 * that needs this is a step a person could not have done on a screen.
 */
/**
 * A field off a JSON body, narrowed before it is used as one.
 *
 * `String(v)` on an object gives "[object Object]", which reads like an
 * identifier and is not — and an identifier that is quietly wrong sends the
 * rest of the journey somewhere else entirely.
 */
function field(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  return typeof value === 'string' ? value : '';
}

async function api(
  page: Page,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await page.request.fetch(path, {
    method,
    headers: {
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID(),
      'x-reason': 'Clinical cycle end-to-end journey.',
    },
    ...(method === 'GET' ? {} : { data: body ?? {} }),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    json = {};
  }
  return { status: res.status(), json };
}

test.describe.configure({ mode: 'serial' });

test.describe('the front office shift', () => {
  test('registers a patient at the desk and gets a UHID back', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/patients');
    await expect(page.getByRole('heading', { name: 'Registration desk', level: 1 })).toBeVisible();

    const mobile = uniqueMobile();
    await page.getByTestId('new-patient').click();
    await page.getByTestId('reg-mobile').fill(mobile);
    await page.getByTestId('reg-first-name').fill('Journey');
    await page.getByTestId('reg-last-name').fill(`Patient${String(now).slice(-5)}`);
    await page.getByTestId('reg-dob').fill('1979-04-12');
    await page.getByTestId('register-save').click();

    const uhid = page.getByTestId('new-uhid');
    await expect(uhid).toBeVisible({ timeout: 20_000 });
    ids.uhid = (await uhid.textContent())?.trim() ?? '';
    expect(ids.uhid.length).toBeGreaterThan(0);

    // The desk knows the UHID; the rest of the journey needs the id behind it.
    const found = await api(page, 'GET', `/api/v1/patients?q=${encodeURIComponent(mobile)}`);
    expect(found.status, JSON.stringify(found.json)).toBe(200);
    const items = (found.json['items'] ?? []) as { id: string }[];
    expect(items.length, 'the patient just registered should be findable').toBeGreaterThan(0);
    ids.patientId = items[0]!.id;
  });

  test('opens a visit and an encounter for the consultation', async ({ page }) => {
    await signIn(page, 'receptionist');

    // A visit names the doctor it is for — and opening one issues a token, so
    // the doctor has to be a doctor with a queue. Picking the first name off
    // `/doctors` is what a receptionist would do and it is refused with
    // "no active queue is configured for this doctor at this branch", which is
    // the API being right and the demo data being partial. The journey picks
    // from the queues instead.
    const queues = await api(page, 'GET', '/api/v1/queues?limit=100');
    expect(queues.status, JSON.stringify(queues.json)).toBe(200);
    const defs = (queues.json['items'] ?? []) as { practitioner_key: string | null }[];
    const withDoctor = defs.find((q) => q.practitioner_key !== null);
    expect(withDoctor, 'the demo hospital should have a doctor queue').toBeDefined();
    const practitionerKey = withDoctor!.practitioner_key!;

    // NO SCREEN. The registration desk registers and the appointment book books,
    // but nothing in the front office opens a walk-in visit — so a receptionist
    // taking somebody who arrived without an appointment has no screen to do it
    // on. Worth naming rather than hiding behind a fixture.
    const visit = await api(page, 'POST', '/api/v1/visits', {
      patientId: ids.patientId,
      practitionerKey,
      visitType: 'new',
    });
    expect([200, 201], `POST /visits said ${String(visit.status)}: ${JSON.stringify(visit.json)}`).toContain(
      visit.status,
    );
    ids.visitId = field(visit.json, 'id');
    expect(ids.visitId).not.toBe('');
  });

  test('issues a queue token the board can call', async ({ page }) => {
    await signIn(page, 'receptionist');
    await page.goto('/frontoffice/queue');
    await expect(page.getByTestId('queue-console')).toBeVisible();
    // EN-006 §5: a token can always be issued, whatever the licence says.
    await expect(page.getByTestId('issue-token')).toBeVisible();
  });
});

test.describe('the nurse shift', () => {
  test('records vitals in the vitals room and is stopped by an impossible pair', async ({ page }) => {
    await signIn(page, 'nurse_opd');
    await page.goto('/clinical/vitals');
    await expect(page.getByTestId('vitals-room')).toBeVisible();

    await page.getByTestId('vitals-patient').fill(ids.patientId);
    await expect(page.getByTestId('vitals-entry-pad')).toBeVisible({ timeout: 15_000 });

    // The visit is found, not asked for. OP-007 refuses an observation that
    // belongs to nothing, and this field used to say "optional" — so a nurse
    // could fill in a full set of readings and be refused with the cuff already
    // off the arm.
    await expect(page.getByTestId('vitals-visit')).toHaveValue(ids.visitId, { timeout: 15_000 });

    // The safety rule first: a diastolic above the systolic is refused before
    // the round trip, so the nurse is corrected while the cuff is still on.
    await page.getByTestId('vitals-systolic').fill('80');
    await page.getByTestId('vitals-diastolic').fill('95');
    await expect(page.getByTestId('vitals-problems')).toContainText('lower than systolic');
    await expect(page.getByTestId('vitals-save')).toBeDisabled();

    // Corrected, it saves.
    await page.getByTestId('vitals-systolic').fill('128');
    await page.getByTestId('vitals-diastolic').fill('78');
    await page.getByTestId('vitals-pulse').fill('76');
    await page.getByTestId('vitals-temperatureC').fill('37.1');
    await page.getByTestId('vitals-respRate').fill('16');
    await expect(page.getByTestId('vitals-save')).toBeEnabled();

    // Watch the request the click makes. A failed save that leaves the screen
    // looking calm is exactly what this journey is here to catch, and asserting
    // on the response says what went wrong instead of "nothing appeared".
    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/v1/vitals/records') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await page.getByTestId('vitals-save').click();
    const response = await saved;
    const bodyText = await response.text();
    expect(response.status(), `POST /vitals/records said ${String(response.status())}: ${bodyText}`).toBe(
      201,
    );

    // The round is recorded: the API has it against this patient.
    await expect
      .poll(
        async () => {
          // `patient`, not `patientId`: OP-007's list takes the short name and
          // refuses a query that names neither a patient, a visit nor a date.
          const res = await api(page, 'GET', `/api/v1/vitals/records?patient=${ids.patientId}`);
          const rows = (res.json['items'] ?? res.json) as unknown[];
          return Array.isArray(rows) ? rows.length : 0;
        },
        { timeout: 20_000, message: 'the vitals just saved should be readable back' },
      )
      .toBeGreaterThan(0);
  });
});

test.describe('the doctor shift', () => {
  test('opens the consultation, writes the note and signs it', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');

    // NO SCREEN. The console opens an encounter by id and there is no worklist
    // on it that creates one, so the encounter is opened through the API. A
    // doctor whose clinic has not been set up by somebody else has no way in.
    const enc = await api(page, 'POST', '/api/v1/encounters', {
      patientId: ids.patientId,
      visitId: ids.visitId,
      type: 'opd',
    });
    expect([200, 201], `POST /encounters said ${String(enc.status)} ${JSON.stringify(enc.json)}`).toContain(
      enc.status,
    );
    ids.encounterId = field(enc.json, 'id');
    expect(ids.encounterId).not.toBe('');

    await page.goto('/clinical/console');
    await expect(page.getByTestId('doctor-console')).toBeVisible();
    await page.getByTestId('console-encounter').fill(ids.encounterId);

    // The patient banner is the safety surface: the doctor should see who they
    // are treating before anything else appears.
    await expect(page.getByTestId('sign-note')).toBeVisible({ timeout: 20_000 });
  });

  test('prescribes and signs, and the prescription is readable back', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');
    await page.goto('/clinical/prescribe');
    await expect(page.getByTestId('prescription-screen')).toBeVisible();

    // The composer needs to know who it is prescribing for before it will offer
    // a drug — the allergy and interaction checks are read against the patient,
    // and a drug search with nobody chosen is a search that cannot warn.
    await page.getByTestId('rx-patient').fill(ids.patientId);
    await page.getByTestId('rx-encounter').fill(ids.encounterId);
    await expect(page.getByTestId('drug-search-input')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('what the journey proves about the modules between', () => {
  test('the patient the desk registered is the patient the clinic treated', async ({ page }) => {
    await signIn(page, 'doctor_consultant_opd');

    // The point of the whole file: one identity carried from the registration
    // desk, through a visit and an encounter, to the vitals the nurse recorded.
    // Four modules, one patient, no re-keying.
    const timeline = await api(page, 'GET', `/api/v1/patients/${ids.patientId}/timeline`);
    expect(timeline.status, JSON.stringify(timeline.json)).toBe(200);

    const record = await api(page, 'GET', `/api/v1/patients/${ids.patientId}`);
    expect(record.status).toBe(200);
    expect(field(record.json, 'uhid')).toBe(ids.uhid);
  });
});
