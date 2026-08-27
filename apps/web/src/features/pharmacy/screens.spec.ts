import { CLINICAL_SAFETY_EXEMPT_PERMISSIONS, PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { INVENTORY_SCREENS } from '@/features/inventory/screens';
import { PHASE0_NAV } from '@/lib/nav';
import { PHARMACY_ROUTES, PHARMACY_SCREENS, pharmacyScreen, pharmacyScreensInArea } from './screens';

/**
 * The screen catalogue, which the navigation and the console home read.
 *
 * The failure it exists to prevent is a permission key that does not exist:
 * that hides the screen from *everyone*, and the symptom — "the pharmacist
 * cannot see the counter" — looks exactly like a permissions problem rather
 * than a typo, so it survives a long time.
 */
const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the pharmacy screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of PHARMACY_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  it('explains every denial in plain words', () => {
    for (const screen of PHARMACY_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(PHARMACY_SCREENS.map((s) => s.key)).size).toBe(PHARMACY_SCREENS.length);
    expect(new Set(PHARMACY_SCREENS.map((s) => s.href)).size).toBe(PHARMACY_SCREENS.length);
  });

  /**
   * EN-040 §5 / D-9. A gate a lapsed subscription could switch off is not a
   * gate. The queue, the counter and the recall console are built on
   * `clinicalSafetyExempt` keys, so none of them carries a licence gate — and
   * this asserts the UI does not reintroduce one the permission layer
   * deliberately removed.
   */
  it('never licence-gates a surface medicine or a recall travels through', () => {
    expect(pharmacyScreen('pharmacy-queue').entitlement).toBeNull();
    expect(pharmacyScreen('pharmacy-counter').entitlement).toBeNull();
    expect(pharmacyScreen('pharmacy-recalls').entitlement).toBeNull();
    for (const key of [
      'pharmacy.queue.list',
      'pharmacy.dispense.create',
      'pharmacy.dispense.complete',
      'pharmacy.narcotic.prepare',
      'pharmacy.recall.manage',
      'pharmacy.recall.trace',
    ]) {
      expect(CLINICAL_SAFETY_EXEMPT_PERMISSIONS, key).toContain(key);
    }
  });

  /**
   * The controlled-drug register *is* licence-gated, and deliberately so: it is
   * a statutory record rather than a path medicine travels down. The path
   * medicine travels down is the counter, which is not gated — a hospital in
   * arrears can still dispense a narcotic, it just cannot page the register.
   */
  it('gates the register with the module rather than with the counter', () => {
    expect(pharmacyScreen('pharmacy-controlled').entitlement).toBe('module.pharmacy.enabled');
    expect(pharmacyScreen('pharmacy-counter').entitlement).toBeNull();
  });

  it('groups the screens into the three consoles the nav renders', () => {
    expect(pharmacyScreensInArea('counter')).toHaveLength(4);
    expect(pharmacyScreensInArea('stock')).toHaveLength(2);
    expect(pharmacyScreensInArea('registers')).toHaveLength(2);
  });

  it('exports the route list for whoever wires navigation', () => {
    expect(PHARMACY_ROUTES).toContain('/pharmacy');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/queue');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/counter');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/sales');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/returns');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/expiry');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/recalls');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/controlled');
    expect(PHARMACY_ROUTES).toContain('/pharmacy/day-close');
  });

  /**
   * `docs/06` §6.5 — no PHI in a URL. Every pharmacy route is static: there is
   * no `[id]` segment anywhere, so a patient identifier cannot reach the address
   * bar, the browser history, or a reverse-proxy access log.
   */
  it('declares no route with a dynamic segment', () => {
    for (const route of PHARMACY_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => pharmacyScreen('nope')).toThrow(/Unknown pharmacy screen/u);
  });
});

/**
 * The navigation, which is the third surface reading these lists.
 *
 * `docs/06` §4.1: "never render an item the user cannot use", and "max 2
 * levels". Both are asserted here rather than reviewed, because a nav item with
 * no permission key is offered to everybody and looks correct in a screenshot.
 */
describe('the Phase-4 navigation groups', () => {
  const pharmacy = PHASE0_NAV.find((item) => item.key === 'pharmacy');
  const inventory = PHASE0_NAV.find((item) => item.key === 'inventory');

  it('adds both groups', () => {
    expect(pharmacy).toBeDefined();
    expect(inventory).toBeDefined();
  });

  /**
   * No permission on the parent. A counter pharmacist holds the queue and
   * dispense keys and none of the register or day-close ones; a permission on
   * the parent would hide the whole console from them.
   */
  it('leaves the parents ungated so a partial key-holder still sees their screens', () => {
    expect(pharmacy?.permission).toBeUndefined();
    expect(inventory?.permission).toBeUndefined();
  });

  it('gates every child on the screen catalogue’s own key', () => {
    expect(pharmacy?.children?.map((child) => child.permission)).toEqual(
      PHARMACY_SCREENS.map((screen) => screen.permission),
    );
    expect(inventory?.children?.map((child) => child.permission)).toEqual(
      INVENTORY_SCREENS.map((screen) => screen.permission),
    );
  });

  it('renders every child with a real permission key', () => {
    for (const item of [...(pharmacy?.children ?? []), ...(inventory?.children ?? [])]) {
      expect(item.permission, `${item.key}`).toBeDefined();
      expect(KNOWN_KEYS.has(item.permission ?? ''), `${item.key} → ${String(item.permission)}`).toBe(true);
    }
  });

  it('stays within the two levels docs/06 §4.1 allows', () => {
    for (const item of [...(pharmacy?.children ?? []), ...(inventory?.children ?? [])]) {
      expect(item.children).toBeUndefined();
    }
  });

  it('never puts an identifier in a navigation href', () => {
    for (const item of [pharmacy, inventory]) {
      expect(item?.href).not.toMatch(/[[\]]/u);
      for (const child of item?.children ?? []) expect(child.href).not.toMatch(/[[\]]/u);
    }
  });
});
