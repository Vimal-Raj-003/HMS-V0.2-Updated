import { describe, expect, it } from 'vitest';
import {
  DltTemplateRegistry,
  InMemoryDltRegistrationStore,
  describeContentDrift,
  normaliseToDltContent,
} from './dlt-registry.js';
import { appointmentTemplate } from '../testing/messaging-fixtures.js';
import { appointmentDltRegistration, clinicalSmsTemplate, dltEntity } from '../testing/messaging-fixtures.js';

const HOSPITAL = '11111111-1111-4111-8111-111111111111';
const clock = { now: (): Date => new Date('2026-08-21T04:30:00.000Z') };

async function registry(): Promise<DltTemplateRegistry> {
  const store = new InMemoryDltRegistrationStore();
  const reg = new DltTemplateRegistry({ store, clock });
  await reg.configureEntity(dltEntity(HOSPITAL));
  return reg;
}

describe('DLT registration', () => {
  it('registers a template whose body equals the DLT-registered content', async () => {
    const reg = await registry();
    const result = await reg.register(appointmentDltRegistration(HOSPITAL));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.issues.map((i) => i.message).join('; '));
    expect(result.registration.dltEntityId).toBe('110100001234567890');
    expect(result.registration.headerId).toBe('VIMHMS');
    expect(result.registration.status).toBe('dlt_registered');
  });

  it('refuses a template whose content has drifted from the DLT registration, with a diff', async () => {
    const reg = await registry();
    // One character: a full stop became an exclamation mark. The operator drops
    // every message and reports nothing.
    const drifted = appointmentDltRegistration(HOSPITAL, 'en-IN', {
      body: 'Dear {{1}}, your appointment at Vims Hospital is confirmed for {{2}}! Reply STOP to opt out.',
    });

    const result = await reg.register(drifted);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a drifted template was accepted');

    const drift = result.issues.find((i) => i.code === 'content_drift');
    expect(drift).toBeDefined();
    // The diff is the whole point: "does not match" sends an engineer to
    // re-paste the same text.
    expect(drift?.message).toMatch(/differs at offset \d+/);
    expect(drift?.message).toContain('registered:');
    expect(drift?.message).toContain('template:');
  });

  it('refuses a template that would interpolate a diagnosis or a result value — at REGISTRATION', async () => {
    const reg = await registry();
    const result = await reg.register(clinicalSmsTemplate(HOSPITAL));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a clinical template was registered');

    const clinical = result.issues.filter((i) => i.code === 'clinical_content');
    expect(clinical.length).toBeGreaterThan(0);

    // Every one of the three ways this template leaks is caught, not just the
    // first: the static text names a revealing test, one variable is called
    // `result` and another `diagnosis`.
    const messages = clinical.map((i) => i.message).join('\n');
    expect(messages).toMatch(/hba1c/i);
    expect(messages).toMatch(/'result'/);
    expect(messages).toMatch(/'diagnosis'/);

    // And it is refused before it exists: nothing was stored.
    expect(await reg.lookup(HOSPITAL, 'lab_result_value', 'en-IN')).toBeUndefined();
  });

  it('refuses a variable declared longer than the TRAI 30-character cap', async () => {
    const reg = await registry();
    const result = await reg.register(
      appointmentDltRegistration(HOSPITAL, 'en-IN', {
        variables: [
          { index: 1, name: 'patient', type: 'name', maxLength: 64, sample: 'R Iyer' },
          { index: 2, name: 'slot', type: 'datetime', maxLength: 30, sample: '21-08-2026 10:30' },
        ],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('an over-length variable was accepted');
    expect(result.issues.some((i) => i.code === 'variable_too_long')).toBe(true);
  });

  it('refuses a header that is not registered for the template category', async () => {
    const reg = await registry();
    // `VIMOFR` is the promotional header; a service message may not use it.
    const result = await reg.register(appointmentDltRegistration(HOSPITAL, 'en-IN', { headerId: 'VIMOFR' }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a mismatched header was accepted');
    expect(result.issues.some((i) => i.code === 'header_category_mismatch')).toBe(true);
  });

  it('refuses a promotional template registered under a service category', async () => {
    const reg = await registry();
    const result = await reg.register(
      appointmentDltRegistration(HOSPITAL, 'en-IN', {
        messageClass: 'promotional',
        dltCategory: 'service_implicit',
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a class/category mismatch was accepted');
    expect(result.issues.some((i) => i.code === 'class_category_mismatch')).toBe(true);
  });

  it('refuses a URL that is not on the hospital DLT whitelist', async () => {
    const reg = await registry();
    const body = 'Dear {{1}}, your report is ready: https://bit.ly.example.net/x  Vims Hospital.';
    const result = await reg.register(
      appointmentDltRegistration(HOSPITAL, 'en-IN', {
        templateKey: 'report_ready_lab',
        body,
        registeredContent: normaliseToDltContent(body),
        variables: [{ index: 1, name: 'patient', type: 'name', maxLength: 30, sample: 'R Iyer' }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('an unwhitelisted URL was accepted');
    expect(result.issues.some((i) => i.code === 'url_not_whitelisted')).toBe(true);
  });

  it('refuses everything when the hospital has no DLT entity at all', async () => {
    const reg = new DltTemplateRegistry({ store: new InMemoryDltRegistrationStore(), clock });
    const result = await reg.register(appointmentDltRegistration(HOSPITAL));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('a template was registered with no DLT entity');
    expect(result.issues[0]?.code).toBe('no_entity');
  });
});

describe('DLT send gate', () => {
  it('refuses to render an unregistered template rather than emitting a message that vanishes', async () => {
    const reg = await registry();
    const rendered = await reg.renderForSend({
      template: appointmentTemplate(HOSPITAL),
      locale: 'en-IN',
      values: { patient: 'R Iyer', slot: '21-08-2026 10:30' },
    });

    expect(rendered.ok).toBe(false);
    if (rendered.ok) throw new Error('an unregistered template rendered');
    expect(rendered.reason).toBe('template_unregistered');
    expect(rendered.detail).toMatch(/dropped by the operator without an error/);
  });

  it('refuses a template that was edited after it was registered', async () => {
    const reg = await registry();
    await reg.register(appointmentDltRegistration(HOSPITAL));

    // The template master is editable. Someone fixes the greeting six weeks
    // later, and at that instant the template is unregistered without knowing it.
    const edited = appointmentTemplate(
      HOSPITAL,
      'en-IN',
      'Dear {{1}}, your appointment at Vims Hospital is CONFIRMED for {{2}}. Reply STOP to opt out.',
    );

    const rendered = await reg.renderForSend({
      template: edited,
      locale: 'en-IN',
      values: { patient: 'R Iyer', slot: '21-08-2026 10:30' },
    });

    expect(rendered.ok).toBe(false);
    if (rendered.ok) throw new Error('a drifted template rendered');
    expect(rendered.reason).toBe('template_drift');
    expect(rendered.detail).toMatch(/edited since it was registered/);
    expect(rendered.detail).toMatch(/differs at offset/);
  });

  it('renders the registered body and returns the DLT ids the gateway needs', async () => {
    const reg = await registry();
    await reg.register(appointmentDltRegistration(HOSPITAL));

    const rendered = await reg.renderForSend({
      template: appointmentTemplate(HOSPITAL),
      locale: 'en-IN',
      values: { patient: 'R Iyer', slot: '21-08-2026 10:30' },
    });

    expect(rendered.ok).toBe(true);
    if (!rendered.ok) throw new Error(rendered.detail);
    expect(rendered.body).toBe(
      'Dear R Iyer, your appointment at Vims Hospital is confirmed for 21-08-2026 10:30. Reply STOP to opt out.',
    );
    expect(rendered.registration.dltTemplateId).toBe('1707169999999900001');
    expect(rendered.parameters).toEqual(['R Iyer', '21-08-2026 10:30']);
    // The hash proves two messages carried the same values while carrying none.
    expect(rendered.varsHash).toMatch(/^[0-9a-f]{32}$/);
  });

  it('refuses a value longer than 30 characters, which the carrier would truncate silently', async () => {
    const reg = await registry();
    await reg.register(appointmentDltRegistration(HOSPITAL));

    const rendered = await reg.renderForSend({
      template: appointmentTemplate(HOSPITAL),
      locale: 'en-IN',
      values: { patient: 'Ramachandran Venkataraghavan Iyer Junior', slot: '21-08-2026 10:30' },
    });

    expect(rendered.ok).toBe(false);
    if (rendered.ok) throw new Error('an over-length value rendered');
    expect(rendered.reason).toBe('variable_too_long');
  });

  it('refuses a clinical value smuggled through a name-typed variable', async () => {
    const reg = await registry();
    await reg.register(appointmentDltRegistration(HOSPITAL));

    // Registration cannot see values. This is the second, narrower check.
    const rendered = await reg.renderForSend({
      template: appointmentTemplate(HOSPITAL),
      locale: 'en-IN',
      values: { patient: 'Oncology review', slot: '21-08-2026 10:30' },
    });

    expect(rendered.ok).toBe(false);
    if (rendered.ok) throw new Error('a clinical value rendered');
    expect(rendered.reason).toBe('clinical_value');
  });

  it('falls back to the en-IN registration when a language variant has none', async () => {
    const reg = await registry();
    await reg.register(appointmentDltRegistration(HOSPITAL, 'en-IN'));

    const found = await reg.lookup(HOSPITAL, 'appointment_confirmed', 'ta');
    expect(found?.locale).toBe('en-IN');
  });
});

describe('describeContentDrift', () => {
  it('reports identical texts as identical', () => {
    expect(describeContentDrift('abc', 'abc')).toBe('identical');
  });

  it('names the offset and both characters', () => {
    const description = describeContentDrift('hello world.', 'hello world!');
    // Extracted rather than string-matched: the repository lint bans the literal
    // `OFFSET <n>` anywhere in source, because it is how banned SQL pagination
    // gets past review.
    expect(/offset (\d+)/.exec(description)?.[1]).toBe('11');
    expect(description).toContain('"."');
    expect(description).toContain('"!"');
  });

  it('handles one text being a prefix of the other', () => {
    expect(describeContentDrift('hello world', 'hello')).toContain('(end of text)');
  });
});
