/**
 * Curated HSN / SAC → GST rate lookup.
 *
 * Ported from the reference GST billing app (IamRamgarhia/Free-GST-Billing-Software,
 * MIT). The full CBIC schedule has ~50k rows (~5 MB); this is a hand-picked subset
 * covering the codes that show up on most small-business invoices, plus the common
 * SAC service codes. It is a *hint* for the invoice line editor — the user can always
 * override the suggested rate on the line.
 *
 * Sources: CBIC HSN/SAC master and Notification 01/2017 (Central Tax Rate), as amended.
 *
 * Lookup order: exact (4–8 digits) → 6-digit prefix → 4-digit prefix.
 * Codes starting with "99" are SAC (services), everything else is goods (HSN).
 */

export interface GstRateHint {
  rate: number
  label: string
}

export const HSN_RATES: Record<string, GstRateHint> = {
  // Food & grocery (0% / 5%)
  '0401': { rate: 0, label: 'Fresh milk' },
  '0701': { rate: 0, label: 'Potatoes, fresh' },
  '0702': { rate: 0, label: 'Tomatoes, fresh' },
  '0713': { rate: 0, label: 'Dried leguminous vegetables' },
  '0801': { rate: 5, label: 'Coconuts, brazil nuts, cashew nuts' },
  '0802': { rate: 12, label: 'Other nuts (almonds, walnuts, pistachio)' },
  '0901': { rate: 5, label: 'Coffee, not roasted' },
  '0902': { rate: 5, label: 'Tea, packed' },
  '1006': { rate: 0, label: 'Rice, unbranded' },
  '1101': { rate: 0, label: 'Wheat flour (unbranded)' },
  '1701': { rate: 5, label: 'Cane / beet sugar' },
  '1704': { rate: 18, label: 'Confectionery, no cocoa' },
  '1806': { rate: 18, label: 'Chocolate & cocoa products' },
  '1905': { rate: 18, label: 'Bread, pastry, cakes, biscuits' },
  '2201': { rate: 18, label: 'Waters (mineral / aerated, no added sugar)' },
  '2202': { rate: 28, label: 'Waters with added sugar / aerated drinks' },

  // Textiles & apparel
  '5205': { rate: 5, label: 'Cotton yarn' },
  '5208': { rate: 5, label: 'Cotton fabric' },
  '6109': { rate: 5, label: 'T-shirts, singlets, tank tops (< ₹1000)' },
  '6110': { rate: 5, label: 'Sweaters, pullovers (< ₹1000)' },
  '6203': { rate: 5, label: "Men's suits, jackets, trousers (< ₹1000)" },
  '6204': { rate: 5, label: "Women's suits, dresses (< ₹1000)" },
  '6205': { rate: 5, label: "Men's shirts (< ₹1000)" },
  '6206': { rate: 5, label: "Women's blouses, shirts (< ₹1000)" },
  '6403': { rate: 5, label: 'Footwear (< ₹1000)' },

  // Paper, books, stationery
  '4801': { rate: 12, label: 'Newsprint' },
  '4802': { rate: 12, label: 'Uncoated paper' },
  '4820': { rate: 18, label: 'Registers, notebooks, letter pads' },
  '4901': { rate: 0, label: 'Printed books, brochures, leaflets' },
  '4907': { rate: 12, label: 'Postage stamps' },
  '4909': { rate: 12, label: 'Printed cards (birthday, greeting)' },
  '4911': { rate: 12, label: 'Printed matter, other' },
  '9608': { rate: 18, label: 'Ballpoint pens, felt-tip, markers' },
  '9609': { rate: 18, label: 'Pencils, crayons, chalks' },

  // IT / electronics
  '8471': { rate: 18, label: 'Computers, laptops, tablets' },
  '8473': { rate: 18, label: 'Parts & accessories for computers' },
  '8517': { rate: 18, label: 'Mobile phones, landline phones' },
  '8523': { rate: 18, label: 'Recorded media (CDs, DVDs, memory cards)' },
  '8528': { rate: 28, label: 'TVs, monitors, projectors' },
  '8536': { rate: 18, label: 'Electrical apparatus (switches, plugs)' },
  '8544': { rate: 18, label: 'Insulated wires & cables' },
  '9004': { rate: 12, label: 'Spectacles, goggles' },

  // Furniture, hardware, building
  '7308': { rate: 18, label: 'Structures of iron / steel' },
  '7318': { rate: 18, label: 'Screws, bolts, nuts, washers' },
  '9401': { rate: 18, label: 'Seats (chairs, sofas) — HSN default' },
  '9403': { rate: 18, label: 'Other furniture (tables, cabinets)' },
  '9405': { rate: 12, label: 'Lamps, lighting fittings' },
  '6810': { rate: 18, label: 'Cement / concrete / stone articles' },
  '6907': { rate: 18, label: 'Ceramic tiles, mosaic cubes' },
  '2523': { rate: 28, label: 'Portland cement' },

  // Health, cosmetics, cleaning
  '3004': { rate: 12, label: 'Medicaments, packed for retail' },
  '3005': { rate: 12, label: 'Wadding, gauze, bandages' },
  '3305': { rate: 18, label: 'Hair care preparations (shampoo, oils)' },
  '3401': { rate: 18, label: 'Soap, toilet preparations' },
  '3402': { rate: 18, label: 'Detergents, cleaning preparations' },

  // Automotive
  '8703': { rate: 28, label: 'Motor cars, station wagons (+ Cess)' },
  '8711': { rate: 28, label: 'Motorcycles, scooters (+ Cess on some)' },
  '4011': { rate: 28, label: 'New pneumatic tyres' },

  // Packaging & other common
  '3923': { rate: 18, label: 'Plastic articles for packaging' },
  '4819': { rate: 12, label: 'Cartons, boxes, cases of paper' },
  '7013': { rate: 18, label: 'Glassware for table, kitchen, decoration' },
  '9615': { rate: 18, label: 'Combs, hair-slides' },

  // Engineering / fabrication (Nashilk-style job shops)
  '7208': { rate: 18, label: 'Flat-rolled iron / non-alloy steel (hot-rolled)' },
  '7214': { rate: 18, label: 'Bars & rods of iron / non-alloy steel' },
  '7315': { rate: 18, label: 'Chain and parts thereof' },
  '7326': { rate: 18, label: 'Other articles of iron or steel' },
  '8482': { rate: 18, label: 'Ball or roller bearings' },
  '8483': { rate: 18, label: 'Transmission shafts, gears, couplings' },
  '8484': { rate: 18, label: 'Gaskets, seals and similar joints' },
  '8413': { rate: 18, label: 'Pumps for liquids' },
  '8414': { rate: 18, label: 'Air / vacuum pumps and compressors' },
  '8462': { rate: 18, label: 'Machine tools for working metal' },
  '8458': { rate: 18, label: 'Lathes for removing metal' },
  '8460': { rate: 18, label: 'Grinding, honing, lapping machines' },
  '7320': { rate: 18, label: 'Springs and leaves for springs' },
  '4016': { rate: 18, label: 'Rubber articles (gaskets, hoses)' },
  '2710': { rate: 18, label: 'Lubricating oils & greases' },
  '3820': { rate: 18, label: 'Anti-freezing preparations' },

  // Paints, chemicals
  '3208': { rate: 18, label: 'Paints and varnishes (synthetic polymers)' },
  '3209': { rate: 18, label: 'Paints and varnishes (aqueous medium)' },
  '2804': { rate: 18, label: 'Hydrogen, rare gases' },
  '3814': { rate: 18, label: 'Thinners, paint removers' },
}

export const SAC_RATES: Record<string, GstRateHint> = {
  '9954': { rate: 18, label: 'Construction services (residential / commercial)' },
  '9963': { rate: 5, label: 'Restaurant & catering — non-AC without alcohol' },
  '9964': { rate: 5, label: 'Passenger transport — road (AC)' },
  '9965': { rate: 5, label: 'Goods transport — road (GTA)' },
  '9967': { rate: 18, label: 'Supporting services for transport' },
  '9971': { rate: 18, label: 'Financial and related services (except banking)' },
  '9972': { rate: 18, label: 'Real estate services (except lease of land)' },
  '9973': { rate: 18, label: 'Leasing / rental services (industrial equipment)' },
  '9981': { rate: 18, label: 'Research and development services' },
  '9982': { rate: 18, label: 'Legal and accounting services' },
  '9983': { rate: 18, label: 'Consulting, management, technical services' },
  '9984': { rate: 18, label: 'Telecommunications, broadcasting services' },
  '9985': { rate: 18, label: 'Support services (BPO, HR, security)' },
  '9986': { rate: 18, label: 'Agriculture, forestry, fishing support services' },
  '9987': { rate: 18, label: 'Maintenance, repair & installation (except construction)' },
  '9988': { rate: 5, label: 'Job work services (textiles, jewellery)' },
  '9989': { rate: 18, label: 'Other manufacturing services (job work, misc)' },
  '9991': { rate: 18, label: 'Public administration services' },
  '9992': { rate: 18, label: 'Education services (private, non-recognized)' },
  '9993': { rate: 0, label: 'Human health services (exempt)' },
  '9994': { rate: 18, label: 'Sewage, waste management' },
  '9995': { rate: 18, label: 'Membership, professional bodies' },
  '9996': { rate: 18, label: 'Recreational, cultural, sporting (event mgmt, design)' },
  '9997': { rate: 18, label: 'Other services (personal care, laundry, misc)' },
  '9998': { rate: 18, label: 'Domestic services' },
  '998314': { rate: 18, label: 'Software development / IT services' },
  '998331': { rate: 18, label: 'Manufacturing services on physical inputs owned by others' },
  '998713': { rate: 18, label: 'Repair & maintenance of industrial machinery' },
}

/** Suggest a GST rate for an HSN (goods) or SAC (services, codes starting with 99). */
export function suggestGstRate(hsnOrSac?: string | null): GstRateHint | null {
  if (!hsnOrSac) return null
  const clean = String(hsnOrSac).replace(/\s+/g, '').toUpperCase()
  if (!/^\d{4,8}$/.test(clean)) return null
  const table = clean.startsWith('99') ? SAC_RATES : HSN_RATES
  return table[clean] || table[clean.slice(0, 6)] || table[clean.slice(0, 4)] || null
}

/** Flat list of every known rate hint, for type-ahead suggestions in the UI. */
export const GST_CODE_HINTS: { code: string; rate: number; label: string; kind: 'HSN' | 'SAC' }[] = [
  ...Object.entries(HSN_RATES).map(([code, h]) => ({ code, rate: h.rate, label: h.label, kind: 'HSN' as const })),
  ...Object.entries(SAC_RATES).map(([code, h]) => ({ code, rate: h.rate, label: h.label, kind: 'SAC' as const })),
]
