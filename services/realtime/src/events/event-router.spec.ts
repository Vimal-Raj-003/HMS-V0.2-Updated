import { describe, expect, it } from 'vitest';
import { parseRoom } from '../rooms/rooms.js';
import { ROUTED_EVENT_TYPES, routeEvent, type StreamEvent } from './event-router.js';

const HOSPITAL = '11111111-1111-7111-8111-111111111111';
const OTHER_HOSPITAL = '22222222-2222-7222-8222-222222222222';
const BRANCH = '33333333-3333-7333-8333-333333333333';
const QUEUE = '44444444-4444-7444-8444-444444444444';
const DOCTOR = '55555555-5555-7555-8555-555555555555';

function event(over: Partial<StreamEvent> = {}): StreamEvent {
  return {
    id: '66666666-6666-7666-8666-666666666666',
    type: 'queue.token.called',
    aggregate: 'queue_token',
    aggregateId: '77777777-7777-7777-8777-777777777777',
    hospitalId: HOSPITAL,
    branchId: BRANCH,
    containsPhi: false,
    occurredAt: '2026-08-23T12:00:00.000Z',
    payload: { queueId: QUEUE, tokenNo: 'A-042', counterOrRoom: 'OPD 3', screenId: 'lobby' },
    ...over,
  };
}

describe('event routing', () => {
  it('puts a called token on its queue room and the lobby display', () => {
    const decision = routeEvent(event());
    const kinds = decision.rooms.map((r) => parseRoom(r)?.kind).sort();
    expect(kinds).toEqual(['display', 'queue']);
    expect(decision.unrouted).toBe(false);
  });

  /**
   * `EN-018 §5`: no patient identifier on a screen in a public waiting area.
   *
   * This is the assertion that has to survive every future edit to the table
   * above. A rule author adding a display room to a PHI event should not be able
   * to make this fail — the gate runs after every rule, in the only exported
   * entry point, so there is nowhere to put the mistake.
   */
  it('never sends a PHI event to a display, however the rule was written', () => {
    const decision = routeEvent(event({ containsPhi: true }));
    expect(decision.rooms.map((r) => parseRoom(r)?.kind)).not.toContain('display');
    expect(decision.withheldFromDisplays).toBe(1);
  });

  it('still delivers the PHI event to the rooms that may have it', () => {
    // Withholding from the board must not mean withholding from the staff who
    // need it. Dropping the whole event would be the opposite failure.
    const decision = routeEvent(event({ containsPhi: true }));
    expect(decision.rooms.length).toBeGreaterThan(0);
    expect(decision.rooms.map((r) => parseRoom(r)?.kind)).toContain('queue');
  });

  it('routes a critical result to the ordering clinician and the acute areas', () => {
    const decision = routeEvent(
      event({
        type: 'lab.result.critical',
        containsPhi: true,
        payload: { orderingDoctorUserId: DOCTOR, patientId: DOCTOR },
      }),
    );
    const kinds = decision.rooms.map((r) => parseRoom(r)?.kind).sort();
    expect(kinds).toEqual(['bedboard', 'er', 'user']);
    expect(kinds).not.toContain('display');
  });

  it('routes an escalation the same way as the alert that raised it', () => {
    // The escalation is the *same* clinical fact arriving later and louder. If
    // it reached fewer screens than the original, escalating would narrow the
    // audience, which is precisely backwards.
    const original = routeEvent(
      event({ type: 'lab.result.critical', containsPhi: true, payload: { orderingDoctorUserId: DOCTOR } }),
    );
    const escalated = routeEvent(
      event({
        type: 'lab.critical.escalated',
        containsPhi: true,
        payload: { orderingDoctorUserId: DOCTOR },
      }),
    );
    expect([...escalated.rooms].sort()).toEqual([...original.rooms].sort());
  });

  it('every room it returns names the event own hospital', () => {
    for (const type of ROUTED_EVENT_TYPES) {
      const decision = routeEvent(
        event({ type, payload: { queueId: QUEUE, screenId: 'lobby', orderingDoctorUserId: DOCTOR } }),
      );
      for (const room of decision.rooms) {
        expect(parseRoom(room)?.hospitalId, `${type} -> ${room}`).toBe(HOSPITAL);
      }
    }
  });

  /**
   * The honest form of the tenancy assertion.
   *
   * The first version of this test set `event.hospitalId` to another tenant and
   * expected the rooms to be discarded -- but every rule builds its rooms from
   * `event.hospitalId`, so that moves the whole event to the other hospital
   * consistently and correctly, and nothing is crossed. It asserted a property
   * the code does not have and would have been "fixed" by weakening the gate.
   *
   * What can actually be attacked is the payload, which is the only part of a
   * stream record that a rule reads freely. So: put a foreign hospital id in it
   * under every key a rule might reach for, and assert no room follows it.
   *
   * `crossTenantDiscarded` itself is defence-in-depth against a *future* rule --
   * no current rule can produce a foreign room, so it stays zero, and the test
   * says zero rather than pretending to exercise it.
   */
  it('lets no payload field steer an event into another hospital room', () => {
    for (const type of ROUTED_EVENT_TYPES) {
      const decision = routeEvent(
        event({
          type,
          payload: {
            queueId: QUEUE,
            screenId: 'lobby',
            orderingDoctorUserId: DOCTOR,
            // Every plausible smuggling vector, all at once.
            hospitalId: OTHER_HOSPITAL,
            tenantId: OTHER_HOSPITAL,
            branchId: OTHER_HOSPITAL,
          },
        }),
      );
      for (const room of decision.rooms) {
        expect(parseRoom(room)?.hospitalId, `${type} -> ${room}`).toBe(HOSPITAL);
      }
      expect(decision.crossTenantDiscarded).toBe(0);
    }
  });

  it('reports an unknown event as unrouted instead of pretending it was delivered', () => {
    const decision = routeEvent(event({ type: 'billing.invoice.finalised' }));
    expect(decision.unrouted).toBe(true);
    expect(decision.rooms).toEqual([]);
  });

  it('routes no event without a queue id to a queue room', () => {
    const decision = routeEvent(event({ payload: {} }));
    expect(decision.rooms).toEqual([]);
    expect(decision.unrouted).toBe(false);
  });

  it('knows about at least the queue and critical-alert families', () => {
    // An empty table would make every assertion above vacuous.
    expect(ROUTED_EVENT_TYPES.length).toBeGreaterThan(10);
    expect(ROUTED_EVENT_TYPES).toContain('queue.token.called');
    expect(ROUTED_EVENT_TYPES).toContain('lab.result.critical');
  });
});
