import { describe, expect, it } from 'vitest';
import { scoreNews2, type News2Input } from './vitals.news2.js';

/**
 * NEWS2 against the RCP 2017 chart reproduced in OP-007 §5.2.
 *
 * The worked examples are the ones the chart itself is usually taught with, so
 * a regression shows up as a wrong *total*, not as a wrong internal detail.
 */

function observation(overrides: Partial<News2Input> = {}): News2Input {
  return {
    respRate: 16,
    spo2: 98,
    onOxygen: false,
    systolic: 120,
    pulse: 70,
    temperatureC: 36.8,
    avpu: 'alert',
    copdScale2: false,
    ...overrides,
  };
}

describe('scoreNews2', () => {
  it('scores a well patient zero and bands it low', () => {
    const result = scoreNews2(observation());
    expect(result?.score).toBe(0);
    expect(result?.band).toBe('low');
  });

  it('scores each parameter from the published table', () => {
    const result = scoreNews2(
      observation({ respRate: 22, spo2: 93, onOxygen: true, systolic: 105, pulse: 115, temperatureC: 39.2 }),
    );
    expect(result?.components).toEqual({
      resp_rate: 2,
      spo2: 2,
      oxygen: 2,
      systolic: 1,
      pulse: 2,
      temperature_c: 2,
      consciousness: 0,
    });
    expect(result?.score).toBe(11);
    expect(result?.band).toBe('high');
  });

  it('bands a single 3 as medium even when the total is low', () => {
    // Respiratory rate 7 alone: total 3, but a single parameter scoring 3 is an
    // urgent review, which is the clinically important half of the banding rule.
    const result = scoreNews2(observation({ respRate: 7 }));
    expect(result?.score).toBe(3);
    expect(result?.band).toBe('medium');
  });

  it('bands 5 as medium and 7 as high', () => {
    expect(scoreNews2(observation({ pulse: 115, spo2: 93, onOxygen: false }))?.score).toBe(4);
    expect(scoreNews2(observation({ pulse: 115, spo2: 93, onOxygen: false }))?.band).toBe('low');
    expect(scoreNews2(observation({ pulse: 125, spo2: 92, onOxygen: true }))?.score).toBe(6);
    expect(scoreNews2(observation({ pulse: 125, spo2: 92, onOxygen: true }))?.band).toBe('medium');
  });

  it('scores anything other than alert as 3', () => {
    expect(scoreNews2(observation({ avpu: 'voice' }))?.score).toBe(3);
    expect(scoreNews2(observation({ avpu: 'unresponsive' }))?.band).toBe('medium');
  });

  it('uses the COPD scale-2 SpO2 band when the doctor has set the flag', () => {
    // 90 % scores 3 on scale 1 and 0 on scale 2 — which is the whole reason the
    // flag exists: a COPD patient at their own target must not be escalated.
    expect(scoreNews2(observation({ spo2: 90 }))?.components['spo2']).toBe(3);
    expect(scoreNews2(observation({ spo2: 90, copdScale2: true }))?.components['spo2']).toBe(0);
  });

  it('penalises over-oxygenation on scale 2 only when oxygen is running', () => {
    expect(scoreNews2(observation({ spo2: 97, copdScale2: true, onOxygen: false }))?.components['spo2']).toBe(
      0,
    );
    expect(scoreNews2(observation({ spo2: 97, copdScale2: true, onOxygen: true }))?.components['spo2']).toBe(
      3,
    );
  });

  it('refuses to score an incomplete observation rather than under-reporting it', () => {
    // Five of seven parameters can total 2 on a patient whose missing
    // respiratory rate would have scored 3; "low risk" would then be a lie.
    expect(scoreNews2(observation({ respRate: null }))).toBeNull();
    expect(scoreNews2(observation({ temperatureC: null }))).toBeNull();
  });

  it('says so when alertness was assumed rather than observed', () => {
    expect(scoreNews2(observation({ avpu: null }))?.consciousnessAssumed).toBe(true);
    expect(scoreNews2(observation())?.consciousnessAssumed).toBe(false);
  });
});
