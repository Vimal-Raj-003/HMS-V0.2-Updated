/**
 * PE-009 §S — what the assistant refuses to do, decided before the model runs.
 *
 * This file exists because of one distinction. A system prompt is a *request*
 * to a language model; a function that returns before the model is called is a
 * *property* of the system. Every published jailbreak works by talking the model
 * out of its instructions, and none of them can talk this out of anything,
 * because by the time a model could be persuaded the answer has already been
 * sent.
 *
 * It is the same argument the schema makes about the vinca route (OP-031 §B.2)
 * and the foetal-sex column (OP-040 §B.6): the proof that a thing cannot happen
 * is that nothing in the system can express it.
 *
 * ── Two jobs ────────────────────────────────────────────────────────────────
 *
 * 1. Red flags. A visitor describing chest pain or a stroke is not a
 *    marketing conversation. They get one answer, immediately, and it is to
 *    stop typing and call for help. The model is not consulted, because a model
 *    that is 99% reliable here is a model that kills somebody on the hundredth
 *    conversation.
 *
 * 2. Everything else clinical. Symptoms, diagnoses, doses, whether to stop
 *    a medicine, whether a lump is serious. A hospital's website assistant has
 *    no examination, no history and no licence. It says so and offers the
 *    consultation that would.
 *
 * ── An honest limitation ────────────────────────────────────────────────────
 *
 * Substring matching is a blunt instrument, and this list was written by an
 * engineer, not a clinician. It is deliberately over-inclusive — a false
 * positive costs a visitor one unnecessary sentence about calling 112, and a
 * false negative costs considerably more. Before this is switched on for a live
 * hospital, the list belongs in front of that hospital's emergency physician,
 * and it should become configurable master data rather than a constant. That is
 * recorded as an open question rather than pretended away.
 */

export type SafetyVerdict =
  | { readonly kind: 'clear' }
  | { readonly kind: 'emergency'; readonly matched: string; readonly reply: string }
  | { readonly kind: 'clinical'; readonly matched: string; readonly reply: string };

/**
 * Symptoms and situations that mean "stop, call for help now".
 *
 * Written lower-case; the input is lower-cased and whitespace-collapsed before
 * matching. A handful of common Hindi transliterations are included because a
 * visitor in distress reaches for their first language, and the phrases chosen
 * are ones that do not collide with ordinary enquiry wording.
 */
const EMERGENCY_PATTERNS: readonly string[] = [
  // Cardiac and respiratory
  'chest pain',
  'chest pressure',
  'chest tightness',
  'tightness in my chest',
  'pain in my chest',
  'seene mein dard',
  'seene me dard',
  'heart attack',
  'cardiac arrest',
  'chest hurts',
  'chest hurting',
  'cannot breathe',
  'cant breathe',
  'not able to breathe',
  'difficulty breathing',
  'trouble breathing',
  'gasping',
  'saans nahi',
  // Stroke
  'face drooping',
  'slurred speech',
  'cannot speak',
  'weakness on one side',
  'numbness on one side',
  'sudden numbness',
  'having a stroke',
  // Catastrophic bleeding and trauma
  'bleeding heavily',
  'heavy bleeding',
  'bleeding a lot',
  'wont stop bleeding',
  'not stop bleeding',
  'severe bleeding',
  'coughing blood',
  'vomiting blood',
  'road accident',
  'major accident',
  // Loss of consciousness and neurological
  'unconscious',
  'unresponsive',
  'not waking up',
  'passed out',
  'collapsed',
  'having a seizure',
  'having a fit',
  'convulsion',
  'convulsions',
  // Airway and anaphylaxis
  'choking',
  'throat closing',
  'tongue swelling',
  'anaphylaxis',
  'severe allergic reaction',
  // Poisoning
  'overdose',
  'poisoned',
  'swallowed poison',
  'took too many tablets',
  // Obstetric
  'in labour',
  'in labor',
  'water broke',
  'waters broke',
  'bleeding in pregnancy',
  'baby not moving',
  'reduced fetal movement',
  'reduced foetal movement',
  // Self-harm. Handled with the same urgency and a different closing line.
  'kill myself',
  'end my life',
  'want to die',
  'suicidal',
  'suicide',
  'harm myself',
  'hurt myself',
];

/** Phrases that mean "this person wants medical advice", short of an emergency. */
const CLINICAL_PATTERNS: readonly string[] = [
  'what medicine',
  'which medicine',
  'what tablet',
  'which tablet',
  'what dose',
  'what dosage',
  'how many mg',
  'how much mg',
  'should i take',
  'can i take',
  'is it safe to take',
  'stop taking',
  'do i have',
  'am i suffering',
  'what is wrong with me',
  'diagnose',
  'is this cancer',
  'is it serious',
  'what could this be',
  'my test result',
  'my report says',
  'interpret my',
  'prescribe',
  'prescription for',
];

/** The self-harm subset gets a different closing sentence. */
const SELF_HARM = new Set([
  'kill myself',
  'end my life',
  'want to die',
  'suicidal',
  'suicide',
  'harm myself',
  'hurt myself',
]);

/**
 * Written as plain sentences, with no markdown.
 *
 * The widget renders a reply as text and never as markup — that is what stops a
 * model's output, which came from whatever a stranger typed, from becoming an
 * XSS. So `**112**` would reach the reader as four asterisks around a phone
 * number, which is exactly the wrong moment to look broken.
 */
const EMERGENCY_REPLY = [
  'That needs urgent medical attention — please stop reading this and get help now.',
  '',
  'Call 112 (all-India emergency) or 108 for an ambulance, or come straight to our Emergency Department, which is open 24 hours and does not need an appointment.',
  '',
  'If someone is with you, tell them now. I am an assistant on a website and cannot assess or treat anybody.',
].join('\n');

const SELF_HARM_REPLY = [
  'I am sorry you are going through this, and I am glad you said something.',
  '',
  'Please talk to a person who can help right now. In India you can call Tele-MANAS on 14416 (free, 24 hours) or the emergency number 112. Our Emergency Department is open 24 hours and you can walk in.',
  '',
  'If you are in immediate danger, please call 112 or ask someone near you to stay with you. I am an assistant on a website — a person can do much more for you than I can.',
].join('\n');

const CLINICAL_REPLY = [
  'I am not able to help with that one, and I would rather say so than guess.',
  '',
  'Questions about symptoms, medicines, doses and test results need a doctor who can examine you and read your history — an assistant on a website has none of that, and a confident wrong answer here is worse than no answer.',
  '',
  'What I can do is get you in front of somebody who can: tell me which department you need, or say "book an appointment" and I will take your details for our front office to call you back.',
].join('\n');

/**
 * Filler words dropped when building the compacted form below.
 *
 * Copulas, auxiliaries, articles and possessives only. Nothing here changes
 * what a sentence is about, which is the property that makes removing them
 * safe — "her face is drooping" and "face drooping" are the same clinical
 * statement, and only one of them is a phrase anybody would think to write in
 * a pattern list.
 */
const FILLER = new Set([
  'is',
  'was',
  'are',
  'were',
  'am',
  'be',
  'been',
  'being',
  'will',
  'would',
  'has',
  'have',
  'had',
  'does',
  'did',
  'do',
  'the',
  'a',
  'an',
  'this',
  'that',
  'my',
  'his',
  'her',
  'their',
  'our',
  'your',
  'its',
  'he',
  'she',
  'they',
  'we',
]);

/** Lower-cased, punctuation-stripped and whitespace-collapsed. */
function normalise(text: string): string {
  return (
    text
      .toLowerCase()
      // Apostrophes are *deleted*, not replaced with a space, so "can't" becomes
      // "cant" rather than "can t". Doing it in the same pass as the rest of the
      // punctuation split every contraction in the language into two words and
      // quietly stopped "I can't breathe" from matching anything.
      .replace(/['\u2019]/g, '')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The same sentence with the filler removed.
 *
 * This exists because the first version of this file matched fixed phrases and
 * missed "her face is drooping and her speech is slurred" — a stroke, described
 * the way a person actually describes one. The patterns said `face drooping`
 * and `slurred speech`; ordinary English put an "is" in the middle of one and
 * reversed the other, and a substring match found neither.
 *
 * Enumerating every inflection would have been a list nobody could review.
 * Matching against both the sentence and its compacted form means one pattern
 * covers "throat closing", "throat is closing" and "her throat was closing",
 * and the list stays short enough to put in front of a clinician.
 */
function compact(normalised: string): string {
  return normalised
    .split(' ')
    .filter((word) => !FILLER.has(word))
    .join(' ');
}

/**
 * Judges the visitor's latest message.
 *
 * Only the latest one: a red flag three turns ago has already been answered,
 * and re-triggering on the whole history would make the conversation unusable
 * for the person who mentioned their father's chest pain last week.
 */
export function screen(message: string): SafetyVerdict {
  const text = normalise(message);
  const compacted = compact(text);
  const hit = (pattern: string): boolean => text.includes(pattern) || compacted.includes(pattern);

  for (const pattern of EMERGENCY_PATTERNS) {
    if (!hit(pattern)) continue;
    return {
      kind: 'emergency',
      matched: pattern,
      reply: SELF_HARM.has(pattern) ? SELF_HARM_REPLY : EMERGENCY_REPLY,
    };
  }

  for (const pattern of CLINICAL_PATTERNS) {
    if (!hit(pattern)) continue;
    return { kind: 'clinical', matched: pattern, reply: CLINICAL_REPLY };
  }

  return { kind: 'clear' };
}

/**
 * The instruction given to the model, when there is one.
 *
 * It is the *second* line of defence, never the first. Everything that must not
 * happen has already been refused by `screen()` above; this exists to keep an
 * ordinary answer in the right register, not to hold a boundary.
 */
export function systemPrompt(hospitalName: string, grounding: string): string {
  return [
    `You are the appointment and information assistant on the website of ${hospitalName}.`,
    '',
    'Your job is to help visitors find the right department, understand what the hospital offers, and start an appointment request. That is all.',
    '',
    'Rules you must follow:',
    '- Never give medical advice, a diagnosis, a medicine, a dose, or an interpretation of a test result. Say you cannot, and offer to help them see a doctor.',
    '- Never invent a doctor, a department, a timing, a price or a phone number. If it is not in the facts below, say you do not have it and offer to have the front office call them.',
    '- Never claim an appointment is booked or confirmed. You can only take a request; a person from the hospital calls back to confirm.',
    '- Do not ask for or repeat medical history, symptoms, or any identity number.',
    '- Be brief. Two or three short sentences unless a list is genuinely clearer.',
    '- Reply in the language the visitor used.',
    '',
    'The only facts you may rely on:',
    grounding,
  ].join('\n');
}
