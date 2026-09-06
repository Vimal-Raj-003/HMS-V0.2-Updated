/**
 * The risk scales, as pure functions.
 *
 * The score is computed from the items and the band from the score. Neither is
 * accepted from a caller: a Morse score somebody typed is a number with no
 * items behind it, and a Braden of 12 filed as "low risk" is a pressure sore in
 * five days. The database checks the same relationship from the other side, so
 * a row that arrived by another path is still refused.
 */

export interface ScaleResult {
  readonly score: number;
  readonly band: 'low' | 'moderate' | 'high' | 'very_high';
  /** How long until it should be done again, in hours. */
  readonly reassessHours: number;
  /** What the scale's own guidance says to do at this band. */
  readonly suggestedInterventions: readonly string[];
}

function sum(items: Readonly<Record<string, number>>): number {
  return Object.values(items).reduce((total, value) => total + value, 0);
}

/**
 * Morse Fall Scale. Higher is worse: 0–24 low, 25–44 moderate, 45+ high.
 *
 * Items: history of falling (0/25), secondary diagnosis (0/15), ambulatory aid
 * (0/15/30), IV or heparin lock (0/20), gait (0/10/20), mental status (0/15).
 */
export function scoreMorse(items: Readonly<Record<string, number>>): ScaleResult {
  const score = sum(items);
  const band = score >= 45 ? 'high' : score >= 25 ? 'moderate' : 'low';
  return {
    score,
    band,
    // On admission, on transfer, after a fall, and on any change of condition —
    // daily is the floor that catches the last of those.
    reassessHours: band === 'high' ? 12 : 24,
    suggestedInterventions:
      band === 'high'
        ? [
            'Bed in the lowest position with brakes on',
            'Call bell within reach and demonstrated',
            'Non-slip footwear',
            'Hourly rounding',
            'Bed rails per policy after a rail-entrapment check',
          ]
        : band === 'moderate'
          ? ['Call bell within reach', 'Non-slip footwear', 'Clear the path to the bathroom']
          : [],
  };
}

/**
 * Braden Scale for pressure injury. Runs the other way: lower is worse.
 *
 * Six items, each 1–4 except friction which is 1–3. ≤9 very high, 10–12 high,
 * 13–14 moderate, 15–18 low, 19–23 no risk. The inversion is the thing that
 * gets miscoded, which is why the database checks the band too.
 */
export function scoreBraden(items: Readonly<Record<string, number>>): ScaleResult {
  const score = sum(items);
  const band = score <= 9 ? 'very_high' : score <= 12 ? 'high' : score <= 14 ? 'moderate' : 'low';
  return {
    score,
    band,
    reassessHours: band === 'very_high' || band === 'high' ? 24 : 48,
    suggestedInterventions:
      band === 'very_high' || band === 'high'
        ? [
            'Alternating pressure mattress',
            'Two-hourly repositioning with a documented turn chart',
            'Heel offloading',
            'Skin inspection at every turn',
            'Dietitian referral',
          ]
        : band === 'moderate'
          ? ['Four-hourly repositioning', 'Pressure-redistributing cushion', 'Daily skin inspection']
          : [],
  };
}

/** Pain, 0–10. Not banded by the database; banded here for the ward list. */
export function scorePain(items: Readonly<Record<string, number>>): ScaleResult {
  const score = Math.min(10, sum(items));
  const band = score >= 7 ? 'high' : score >= 4 ? 'moderate' : 'low';
  return {
    score,
    band,
    reassessHours: band === 'high' ? 1 : 4,
    suggestedInterventions:
      band === 'high'
        ? ['Review the analgesia ladder', 'Reassess within the hour', 'Inform the prescriber']
        : [],
  };
}

/** A simple additive scale for the remaining three. */
function additive(items: Readonly<Record<string, number>>, high: number, moderate: number): ScaleResult {
  const score = sum(items);
  const band = score >= high ? 'high' : score >= moderate ? 'moderate' : 'low';
  return { score, band, reassessHours: 24, suggestedInterventions: [] };
}

export function scoreScale(scale: string, items: Readonly<Record<string, number>>): ScaleResult {
  switch (scale) {
    case 'morse_falls':
      return scoreMorse(items);
    case 'braden_pressure':
      return scoreBraden(items);
    case 'pain':
      return scorePain(items);
    case 'nutrition':
      // MUST: 2+ is high risk, 1 is medium.
      return additive(items, 2, 1);
    case 'dvt':
      // Padua/Caprini-style: 4+ is high.
      return additive(items, 4, 2);
    case 'restraint':
      return additive(items, 3, 1);
    default:
      throw new Error(`Unknown risk scale: ${scale}`);
  }
}
