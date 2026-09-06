import { PERMISSION_CATALOGUE } from '@vims/contracts';
import { describe, expect, it } from 'vitest';
import { INVENTORY_ROUTES, INVENTORY_SCREENS, inventoryScreen, inventoryScreensInArea } from './screens';

const KNOWN_KEYS = new Set(PERMISSION_CATALOGUE.map((permission) => permission.key));

describe('the inventory screen catalogue', () => {
  it('gates every screen on a permission key that actually exists', () => {
    for (const screen of INVENTORY_SCREENS) {
      expect(KNOWN_KEYS.has(screen.permission), `${screen.key} → ${screen.permission}`).toBe(true);
    }
  });

  /**
   * Each screen is gated on the key of the **list it loads first**, so a session
   * that can open the screen can see something on it. A screen gated on a write
   * permission is a screen that renders an empty page for the storekeeper who
   * holds the read.
   */
  it('gates each screen on the key of the list it loads', () => {
    expect(inventoryScreen('inventory-items').permission).toBe('inventory.item.list');
    expect(inventoryScreen('inventory-stock').permission).toBe('inventory.stock.list');
    expect(inventoryScreen('inventory-indents').permission).toBe('inventory.store_indent.list');
    expect(inventoryScreen('inventory-transfers').permission).toBe('inventory.transfer.list');
    expect(inventoryScreen('inventory-adjustments').permission).toBe('inventory.adjustment.list');
    expect(inventoryScreen('inventory-purchase').permission).toBe('inventory.po.list');
    expect(inventoryScreen('inventory-grn').permission).toBe('inventory.grn.list');
    expect(inventoryScreen('inventory-invoices').permission).toBe('inventory.invoice.list');
    expect(inventoryScreen('inventory-vendors').permission).toBe('vendor.master.list');
    // NC-007 opens on the agreements list; NC-008 on the consumption list. The
    // cost-centre roll-up on the same screen is a *finance* key, so gating the
    // screen on it would hide consumption from the storekeeper who records it.
    expect(inventoryScreen('inventory-consignment').permission).toBe('inventory.consignment.agreement.list');
    expect(inventoryScreen('inventory-consumption').permission).toBe('inventory.consumption.list');
    // NC-008's two halves are two screens: the transaction is a stores key, the
    // roll-up a finance one. One screen carrying both was unreachable by finance.
    expect(inventoryScreen('inventory-cost-centres').permission).toBe('finance.costcentre.read');
  });

  it('explains every denial in plain words', () => {
    for (const screen of INVENTORY_SCREENS) {
      expect(screen.summary.length).toBeGreaterThan(20);
      expect(screen.deniedExplanation.length).toBeGreaterThan(20);
      expect(screen.keywords.length).toBeGreaterThan(0);
    }
  });

  it('uses a distinct key and route per screen', () => {
    expect(new Set(INVENTORY_SCREENS.map((s) => s.key)).size).toBe(INVENTORY_SCREENS.length);
    expect(new Set(INVENTORY_SCREENS.map((s) => s.href)).size).toBe(INVENTORY_SCREENS.length);
  });

  /**
   * None of these is on the path a medicine takes to a patient, so all of them
   * are licence-gated — unlike the pharmacy counter, which is not. If a screen
   * here ever needs to be exempt, the reason has to be written down.
   */
  it('licence-gates every store and purchase screen', () => {
    for (const screen of INVENTORY_SCREENS) {
      expect(screen.entitlement, screen.key).toBe('module.inventory.enabled');
    }
  });

  it('groups the screens into the four consoles the nav renders', () => {
    expect(inventoryScreensInArea('stores')).toHaveLength(2);
    expect(inventoryScreensInArea('movements')).toHaveLength(3);
    expect(inventoryScreensInArea('purchase')).toHaveLength(4);
    expect(inventoryScreensInArea('consignment')).toHaveLength(3);
  });

  it('exports the route list for whoever wires navigation', () => {
    for (const route of [
      '/inventory',
      '/inventory/items',
      '/inventory/stock',
      '/inventory/indents',
      '/inventory/transfers',
      '/inventory/adjustments',
      '/inventory/purchase',
      '/inventory/grn',
      '/inventory/invoices',
      '/inventory/vendors',
      '/inventory/consignment',
      '/inventory/consumption',
      '/inventory/cost-centres',
    ]) {
      expect(INVENTORY_ROUTES).toContain(route);
    }
  });

  it('declares no route with a dynamic segment', () => {
    for (const route of INVENTORY_ROUTES) {
      expect(route).not.toMatch(/[[\]]/u);
    }
  });

  it('throws on an unknown screen key rather than rendering an ungated page', () => {
    expect(() => inventoryScreen('nope')).toThrow(/Unknown inventory screen/u);
  });
});
