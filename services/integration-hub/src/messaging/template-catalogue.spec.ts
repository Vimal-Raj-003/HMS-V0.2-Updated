import { describe, expect, it } from 'vitest';
import { InMemoryTemplateStore, TemplateCatalogue, bodyPlaceholderIndices } from './template-catalogue.js';
import { appointmentTemplate, appointmentWhatsAppTemplate } from '../testing/messaging-fixtures.js';

const HOSPITAL = '11111111-1111-4111-8111-111111111111';
const OTHER_HOSPITAL = '22222222-2222-4222-8222-222222222222';

async function catalogue(): Promise<TemplateCatalogue> {
  const store = new InMemoryTemplateStore();
  const cat = new TemplateCatalogue(store);
  await cat.register(appointmentTemplate(HOSPITAL, 'en-IN'));
  return cat;
}

describe('locale resolution', () => {
  it('returns the exact language when one exists', async () => {
    const cat = await catalogue();
    await cat.register({
      ...appointmentTemplate(HOSPITAL, 'ta'),
      body: 'அன்புள்ள {{1}}, உங்கள் சந்திப்பு {{2}} அன்று உறுதி செய்யப்பட்டது.',
    });

    const resolved = await cat.resolve(HOSPITAL, 'appointment_confirmed', 'sms', 'ta');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.resolvedLocale).toBe('ta');
    expect(resolved.fellBackToDefault).toBe(false);
  });

  it('falls back to en-IN when the requested language has no variant', async () => {
    // `@vims/i18n` D-13: "en-IN is always present, always complete, and is the
    // fallback for every other locale". A Tamil hospital that has not yet
    // translated a reminder still sends the reminder.
    const cat = await catalogue();

    const resolved = await cat.resolve(HOSPITAL, 'appointment_confirmed', 'sms', 'ta');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.requestedLocale).toBe('ta');
    expect(resolved.resolvedLocale).toBe('en-IN');
    expect(resolved.fellBackToDefault).toBe(true);
  });

  it('falls back to en-IN and never to a neighbouring language', async () => {
    // Hindi exists, Marathi does not. Marathi must not silently become Hindi
    // just because the scripts are the same.
    const cat = await catalogue();
    await cat.register({ ...appointmentTemplate(HOSPITAL, 'hi'), body: 'प्रिय {{1}}, {{2}}' });

    const resolved = await cat.resolve(HOSPITAL, 'appointment_confirmed', 'sms', 'mr');
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) throw new Error(resolved.detail);
    expect(resolved.resolvedLocale).toBe('en-IN');
  });

  it('refuses when neither the language nor the en-IN fallback exists', async () => {
    const cat = await catalogue();
    const resolved = await cat.resolve(HOSPITAL, 'nothing_here', 'sms', 'ta');
    expect(resolved.ok).toBe(false);
    if (resolved.ok) throw new Error('a missing template resolved');
    expect(resolved.reason).toBe('no_template');
    expect(resolved.detail).toContain('en-IN');
  });

  it('keeps channels apart: an SMS template is not a WhatsApp template', async () => {
    const cat = await catalogue();
    const whatsapp = await cat.resolve(HOSPITAL, 'appointment_confirmed', 'whatsapp', 'en-IN');
    expect(whatsapp.ok).toBe(false);

    await cat.register(appointmentWhatsAppTemplate(HOSPITAL));
    const again = await cat.resolve(HOSPITAL, 'appointment_confirmed', 'whatsapp', 'en-IN');
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.detail);
    expect(again.template.whatsapp?.status).toBe('approved');
  });

  it('keeps hospitals apart', async () => {
    const cat = await catalogue();
    const other = await cat.resolve(OTHER_HOSPITAL, 'appointment_confirmed', 'sms', 'en-IN');
    expect(other.ok).toBe(false);
  });
});

describe('bodyPlaceholderIndices', () => {
  it('lists the placeholders a body actually uses, sorted and de-duplicated', () => {
    expect(bodyPlaceholderIndices('Hi {{2}}, see {{1}} and {{2}} again')).toEqual([1, 2]);
    expect(bodyPlaceholderIndices('no placeholders here')).toEqual([]);
  });
});
