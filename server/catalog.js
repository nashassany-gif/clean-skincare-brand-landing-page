/**
 * Authoritative product catalog.
 *
 * This file is the single source of truth for prices, sizes and stock. The browser
 * only ever sends `{ id, qty }`; everything monetary is recomputed here. Never move
 * these numbers into the client.
 */
'use strict';

const PRODUCTS = {
  melt: {
    id: 'melt',
    name: 'Melt Cleansing Oil',
    size: '150 ml',
    priceCents: 4600,
    stock: 40
  },
  drench: {
    id: 'drench',
    name: 'Drench Renewal Serum',
    size: '30 ml',
    priceCents: 6800,
    stock: 25
  },
  keeper: {
    id: 'keeper',
    name: 'Keeper Barrier Cream',
    size: '50 ml',
    priceCents: 5400,
    stock: 30
  },
  rest: {
    id: 'rest',
    name: 'Rest Clay Mask',
    size: '75 ml',
    priceCents: 3800,
    stock: 15
  }
};

const ORDER = ['melt', 'drench', 'keeper', 'rest'];

/** Shipping rules. Kept server-side so a client cannot pick a cheaper rate. */
const SHIPPING = {
  standard: { label: 'Standard', cents: 600, freeOverCents: 7500 },
  express: { label: 'Express', cents: 1600, freeOverCents: null }
};

/** Flat demo tax rate. A real deployment would use a tax service per jurisdiction. */
const TAX_RATE = 0.08;

const MAX_QTY_PER_LINE = 9;

function getProduct(id) {
  return Object.prototype.hasOwnProperty.call(PRODUCTS, id) ? PRODUCTS[id] : null;
}

function isKnownShipping(method) {
  return Object.prototype.hasOwnProperty.call(SHIPPING, method);
}

module.exports = {
  PRODUCTS,
  ORDER,
  SHIPPING,
  TAX_RATE,
  MAX_QTY_PER_LINE,
  getProduct,
  isKnownShipping
};
