/**
 * fleet-analytics.js
 * Pure computation / analytics module for the Turo Fleet Tracker.
 *
 * All functions are stateless: they receive data as arguments and return
 * computed values. No DOM access, no Firebase calls, no global state reads.
 *
 * Usage (vanilla JS, no build step):
 *   <script src="fleet-analytics.js"></script>
 *   const roi = FleetAnalytics.carRoi(car, trips, expenses);
 */

const FleetAnalytics = (() => {

  // ============================================================
  // FORMATTING HELPERS
  // ============================================================

  function fmt$(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  }

  function fmt$2(n) {
    const v = Number(n) || 0;
    return v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });
  }


  // ============================================================
  // DATE / PARSING UTILITIES
  // ============================================================

  function parseDateLoose(s) {
    if (!s) return null;
    if (s instanceof Date) return s;
    let d = new Date(s);
    if (!isNaN(d)) return d;
    const m = String(s).match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      let [_, mo, da, yr] = m;
      if (yr.length === 2) yr = '20' + yr;
      d = new Date(+yr, +mo - 1, +da);
      if (!isNaN(d)) return d;
    }
    return null;
  }

  function ymKey(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  function ymLabel(key) {
    const [y, m] = key.split('-');
    return new Date(+y, +m - 1, 1).toLocaleString('en-US', { month: 'short', year: '2-digit' });
  }

  /** Parse a currency/number string like "$1,234.56" or "(500)" into a number. */
  function parseAmount(s) {
    if (s === null || s === undefined || s === '') return 0;
    if (typeof s === 'number') return s;
    let str = String(s).trim();
    const negative = /^\(.*\)$/.test(str);
    str = str.replace(/[$,\s()]/g, '');
    const n = parseFloat(str);
    if (isNaN(n)) return 0;
    return negative ? -n : n;
  }

  /** Pick a field from a CSV row by trying candidate column names (case-insensitive). */
  function pickField(row, candidates) {
    const keys = Object.keys(row);
    for (const cand of candidates) {
      const k = keys.find(k => k.toLowerCase().trim() === cand.toLowerCase());
      if (k) return row[k];
    }
    for (const cand of candidates) {
      const k = keys.find(k => k.toLowerCase().includes(cand.toLowerCase()));
      if (k) return row[k];
    }
    return null;
  }

  /** Extract a 4-digit year from a string like "2019 Toyota Camry". */
  function guessYear(s) {
    if (!s) return '';
    const m = String(s).match(/(19|20)\d{2}/);
    return m ? m[0] : '';
  }

  /** Strip year and parenthetical notes, leaving make/model text. */
  function guessMakeModel(s) {
    if (!s) return '';
    return String(s).replace(/\(.*?\)/g, '').replace(/\d{4}/g, '').replace(/\s+/g, ' ').trim();
  }


  // ============================================================
  // LOAN CALCULATIONS
  // ============================================================

  /**
   * Standard amortization monthly payment.
   * P * (r*(1+r)^n) / ((1+r)^n - 1)
   */
  function calculateLoanPayment(principal, aprPct, termMonths) {
    if (!principal || !termMonths || termMonths <= 0) return 0;
    if (!aprPct || aprPct <= 0) return principal / termMonths;
    const r = (aprPct / 100) / 12;
    return principal * (r * Math.pow(1 + r, termMonths)) / (Math.pow(1 + r, termMonths) - 1);
  }

  /**
   * Outstanding loan balance at a given Date using amortization math.
   * loan: { amount, startDate, termMonths, apr }
   */
  function loanOutstandingBalance(loan, asOfDate) {
    if (!loan || !loan.amount || !loan.startDate || !loan.termMonths) return 0;
    const start = parseDateLoose(loan.startDate);
    if (!start) return 0;
    const monthsElapsed = Math.max(0, Math.floor((asOfDate - start) / (1000 * 60 * 60 * 24 * 30.44)));
    if (monthsElapsed >= loan.termMonths) return 0;
    const r = ((loan.apr || 0) / 100) / 12;
    const n = loan.termMonths;
    if (r === 0) return loan.amount * (1 - monthsElapsed / n);
    return loan.amount * (Math.pow(1 + r, n) - Math.pow(1 + r, monthsElapsed)) / (Math.pow(1 + r, n) - 1);
  }

  /**
   * Returns an array of { date: Date, amount: number } for loan payments
   * that fall within [rangeStart, rangeEnd].
   */
  function loanPaymentsInRange(loan, rangeStart, rangeEnd) {
    if (!loan || !loan.monthlyPayment || !loan.startDate || !loan.termMonths) return [];
    const start = parseDateLoose(loan.startDate);
    if (!start) return [];
    const out = [];
    let cur = new Date(start);
    for (let i = 0; i < loan.termMonths; i++) {
      if (!(rangeStart && cur < rangeStart) && !(rangeEnd && cur > rangeEnd)) {
        out.push({ date: new Date(cur), amount: loan.monthlyPayment });
      }
      cur.setMonth(cur.getMonth() + 1);
      if (rangeEnd && cur > rangeEnd) break;
    }
    return out;
  }


  // ============================================================
  // DEPRECIATION & VALUE ESTIMATION
  // ============================================================

  const VALUE_FLOOR = 1500;
  const EXPECTED_MILES_PER_YEAR = 12000;
  const MILEAGE_PENALTY_PER_MILE = 0.08;

  /**
   * Tiered compound depreciation factor for a given age in years.
   * Tiers: 20%/yr yr 1 · 15%/yr yr 2–3 · 12%/yr yr 4–5 · 8%/yr yr 6+
   */
  function depreciationFactorForYears(years) {
    let factor = 1;
    let yrLeft = years;
    const tiers = [[1, 0.20], [2, 0.15], [2, 0.12], [Infinity, 0.08]];
    for (const [span, rate] of tiers) {
      const yrs = Math.min(yrLeft, span);
      factor *= Math.pow(1 - rate, yrs);
      yrLeft -= yrs;
      if (yrLeft <= 0) break;
    }
    return factor;
  }

  /**
   * Estimate current market value from purchase price, purchase date, and
   * optional current mileage. Returns null if insufficient data.
   */
  function estimateCurrentValue(purchasePrice, purchaseDate, currentMileage) {
    if (!purchasePrice || purchasePrice <= 0) return null;
    const purchaseD = parseDateLoose(purchaseDate);
    if (!purchaseD) return null;
    const today = new Date();
    const years = Math.max(0, (today - purchaseD) / (1000 * 60 * 60 * 24 * 365.25));
    const baseValue = purchasePrice * depreciationFactorForYears(years);

    let adjusted = baseValue;
    if (currentMileage && currentMileage > 0) {
      const expectedMilesNow = years * EXPECTED_MILES_PER_YEAR;
      const excess = currentMileage - expectedMilesNow;
      if (excess > 0) adjusted -= excess * MILEAGE_PENALTY_PER_MILE;
    }
    return Math.max(VALUE_FLOOR, Math.round(adjusted));
  }

  /**
   * Returns the effective resale/current value of a car for net-worth purposes.
   * Uses salePrice if sold, otherwise currentValue.
   */
  function carResaleValue(c) {
    if (c.saleDate || c.salePrice) return Number(c.salePrice) || 0;
    return Number(c.currentValue) || 0;
  }


  // ============================================================
  // EXPENSE EXPANSION (recurring → individual occurrences)
  // ============================================================

  /**
   * Expands the expenses array (one-off + recurring + loan payments) into a
   * flat list of individual occurrences filtered to [rangeStart, rangeEnd].
   *
   * @param {Array}  expenses   - raw expense records from state
   * @param {Array}  cars       - car records (for loan expansion)
   * @param {Date|null} rangeStart
   * @param {Date|null} rangeEnd
   * @returns {Array} { carId, date, amount, description, type, category? }
   */
  function expandExpenses(expenses, cars, rangeStart, rangeEnd) {
    const out = [];
    const today = new Date();

    for (const e of expenses) {
      const start = parseDateLoose(e.date);
      if (!start) continue;
      if (e.type !== 'recurring') {
        if (rangeStart && start < rangeStart) continue;
        if (rangeEnd && start > rangeEnd) continue;
        out.push({ carId: e.carId, date: start, amount: e.amount, description: e.description, type: 'one-off' });
        continue;
      }
      const end = e.endDate ? parseDateLoose(e.endDate) : today;
      const stopAt = end < today ? end : today;
      let cur = new Date(start);
      let safety = 0;
      while (cur <= stopAt && safety < 5000) {
        if (!(rangeStart && cur < rangeStart) && !(rangeEnd && cur > rangeEnd)) {
          out.push({ carId: e.carId, date: new Date(cur), amount: e.amount, description: e.description, type: 'recurring' });
        }
        switch (e.frequency) {
          case 'weekly':    cur.setDate(cur.getDate() + 7); break;
          case 'monthly':   cur.setMonth(cur.getMonth() + 1); break;
          case 'quarterly': cur.setMonth(cur.getMonth() + 3); break;
          case 'yearly':    cur.setFullYear(cur.getFullYear() + 1); break;
          default:          cur.setMonth(cur.getMonth() + 1);
        }
        safety++;
      }
    }

    // Loan payments as virtual recurring expenses
    for (const c of cars) {
      if (!c.loan || !c.loan.amount || !c.loan.monthlyPayment || !c.loan.startDate || !c.loan.termMonths) continue;
      const payments = loanPaymentsInRange(c.loan, rangeStart, rangeEnd && rangeEnd < today ? rangeEnd : today);
      for (const p of payments) {
        if (p.date > today) continue;
        out.push({ carId: c.id, date: p.date, amount: p.amount, description: 'Loan payment', type: 'loan', category: 'Loan' });
      }
    }
    return out;
  }


  // ============================================================
  // DATE RANGE HELPERS
  // ============================================================

  /**
   * Returns { start: Date|null, end: Date } for named range keys.
   * Keys: 'all' | 'ytd' | '12m' | '6m' | '3m'
   */
  function rangeBounds(rangeKey) {
    const today = new Date();
    let start = null;
    if (rangeKey === 'ytd') start = new Date(today.getFullYear(), 0, 1);
    else if (rangeKey === '12m') { start = new Date(today); start.setMonth(start.getMonth() - 12); }
    else if (rangeKey === '6m')  { start = new Date(today); start.setMonth(start.getMonth() - 6); }
    else if (rangeKey === '3m')  { start = new Date(today); start.setMonth(start.getMonth() - 3); }
    return { start, end: today };
  }

  /**
   * Total earnings for a car within a date range.
   * @param {string} carId
   * @param {Array}  trips
   * @param {string} rangeKey
   */
  function totalEarnings(carId, trips, rangeKey) {
    const { start, end } = rangeBounds(rangeKey || 'all');
    return trips.filter(t => t.carId === carId).reduce((s, t) => {
      const d = parseDateLoose(t.start);
      if (start && d && d < start) return s;
      if (end && d && d > end) return s;
      return s + (Number(t.earnings) || 0);
    }, 0);
  }

  /**
   * Total expenses for a car within a date range (uses expanded expenses).
   */
  function totalExpenses(carId, expandedExpenses, rangeKey) {
    return expandedExpenses.filter(e => e.carId === carId).reduce((s, e) => s + (Number(e.amount) || 0), 0);
  }

  /**
   * Number of trips for a car within a date range.
   */
  function tripCount(carId, trips, rangeKey) {
    const { start, end } = rangeBounds(rangeKey || 'all');
    return trips.filter(t => {
      if (t.carId !== carId) return false;
      const d = parseDateLoose(t.start);
      if (start && d && d < start) return false;
      if (end && d && d > end) return false;
      return true;
    }).length;
  }


  // ============================================================
  // CAR STATUS HELPERS
  // ============================================================

  function isSold(c) { return !!(c.saleDate || c.salePrice); }

  function activeCars(cars) { return cars.filter(c => !isSold(c)); }

  function carDisplayName(c) { return c.nickname && c.nickname.trim() ? c.nickname : c.name; }

  /** Latest odometer reading from trips (most recent trip end with odometerEnd). */
  function getCarLatestMileage(carId, trips) {
    const matching = trips.filter(t => t.carId === carId && t.odometerEnd && t.odometerEnd > 0)
      .sort((a, b) => (b.end || b.start || '').localeCompare(a.end || a.start || ''));
    return matching.length > 0 ? matching[0].odometerEnd : null;
  }

  function getCarFirstTripDate(carId, trips) {
    const dates = trips.filter(t => t.carId === carId).map(t => parseDateLoose(t.start)).filter(Boolean);
    if (dates.length === 0) return null;
    return new Date(Math.min(...dates));
  }

  function getCarLastTripDate(carId, trips) {
    const dates = trips.filter(t => t.carId === carId).map(t => parseDateLoose(t.end || t.start)).filter(Boolean);
    if (dates.length === 0) return null;
    return new Date(Math.max(...dates));
  }


  // ============================================================
  // ROI CALCULATIONS
  // ============================================================

  /**
   * Per-car ROI.
   * Returns { lifetimePct, annualPct, years, isAnnualized } or null if no purchase price.
   *
   * - lifetimePct = (earnings - expenses + resaleValue - purchasePrice) / purchasePrice * 100
   * - annualPct   = lifetimePct / yearsOwned  (suppressed if < 3 months owned)
   */
  function carRoi(c, trips, expenses, cars) {
    if (!c.purchasePrice || c.purchasePrice <= 0) return null;
    const today = new Date();
    const expandedExp = expandExpenses(expenses, cars || [], null, today);

    const lifeEarn = trips.filter(t => t.carId === c.id).reduce((s, t) => s + (Number(t.earnings) || 0), 0);
    const lifeExp  = expandedExp.filter(e => e.carId === c.id).reduce((s, e) => s + (Number(e.amount) || 0), 0);
    const resale   = carResaleValue(c);
    const lifetimePct = ((lifeEarn - lifeExp + resale - c.purchasePrice) / c.purchasePrice) * 100;

    const purchaseD = c.purchaseDate ? parseDateLoose(c.purchaseDate) : getCarFirstTripDate(c.id, trips);
    const endD      = c.saleDate ? parseDateLoose(c.saleDate) : today;
    const years     = (purchaseD && endD) ? Math.max(0, (endD - purchaseD) / (1000 * 60 * 60 * 24 * 365.25)) : 0;

    if (years < 0.25 || years === 0) {
      return { lifetimePct, annualPct: lifetimePct, years, isAnnualized: false };
    }
    return { lifetimePct, annualPct: lifetimePct / years, years, isAnnualized: true };
  }

  /**
   * Fleet-level weighted-average annual ROI, weighted by purchase price.
   * perCar: array of { car, roi } objects (roi from carRoi()).
   * Returns null if no purchase-price data.
   */
  function avgAnnualRoi(perCar) {
    let weightedRoi = 0, totalWeight = 0;
    for (const p of perCar) {
      if (p.roi && p.car.purchasePrice) {
        weightedRoi += p.roi.annualPct * p.car.purchasePrice;
        totalWeight += p.car.purchasePrice;
      }
    }
    return totalWeight > 0 ? weightedRoi / totalWeight : null;
  }

  /**
   * Fleet-level ROI using the net-worth definition:
   * (activeValue + netCashFlow - activeInvested) / totalInvested * 100
   *
   * Also returns annualized ROI using weighted-average years owned.
   *
   * Returns { fleetRoi, annualizedRoi, avgYears, annualized }
   */
  function fleetRoi(cars, trips, expenses) {
    const today = new Date();
    const active = activeCars(cars);
    const expandedExp = expandExpenses(expenses, cars, null, today);

    const activeValue    = active.reduce((s, c) => s + (Number(c.currentValue) || 0), 0);
    const activeInvested = active.reduce((s, c) => s + (Number(c.purchasePrice) || 0), 0);
    const lifetimeEarn   = cars.reduce((s, c) => s + trips.filter(t => t.carId === c.id).reduce((a, t) => a + (Number(t.earnings) || 0), 0), 0);
    const lifetimeExp    = cars.reduce((s, c) => s + expandedExp.filter(e => e.carId === c.id).reduce((a, e) => a + (Number(e.amount) || 0), 0), 0);
    const netCashFlow    = lifetimeEarn - lifetimeExp;
    const totalInvested  = activeInvested;

    if (totalInvested <= 0) return null;

    const fleetRoiPct = ((activeValue + netCashFlow - activeInvested) / totalInvested) * 100;

    let weightedYears = 0, weightTotal = 0;
    for (const c of cars) {
      if (!c.purchasePrice) continue;
      const purchaseD = c.purchaseDate ? parseDateLoose(c.purchaseDate) : getCarFirstTripDate(c.id, trips);
      const endD      = c.saleDate ? parseDateLoose(c.saleDate) : today;
      if (!purchaseD || !endD) continue;
      const yrs = Math.max(0, (endD - purchaseD) / (1000 * 60 * 60 * 24 * 365.25));
      weightedYears += yrs * c.purchasePrice;
      weightTotal   += c.purchasePrice;
    }
    const avgYears  = weightTotal > 0 ? weightedYears / weightTotal : 0;
    const annualized = avgYears >= 0.25;
    const annualizedRoi = annualized ? fleetRoiPct / avgYears : fleetRoiPct;

    return { fleetRoi: fleetRoiPct, annualizedRoi, avgYears, annualized, netWorth: activeValue + netCashFlow - activeInvested, totalInvested };
  }


  // ============================================================
  // UTILIZATION & ADR
  // ============================================================

  /**
   * Utilization rate for a car: daysRented / daysInFleet * 100.
   * Returns null if daysInFleet cannot be determined.
   */
  function utilizationRate(daysRented, daysInFleet) {
    if (!daysInFleet || daysInFleet <= 0) return null;
    return (daysRented / daysInFleet) * 100;
  }

  /**
   * Average Daily Rate: total earnings / total days rented.
   * Returns null if no rental days.
   */
  function averageDailyRate(totalEarningsAmt, daysRented) {
    if (!daysRented || daysRented <= 0) return null;
    return totalEarningsAmt / daysRented;
  }

  /**
   * Revenue per fleet day = ADR * (utilization / 100).
   * The single best metric for comparing cars of different price tiers.
   */
  function revenuePerFleetDay(adr, utilizationPct) {
    if (adr === null || utilizationPct === null) return null;
    return adr * (utilizationPct / 100);
  }


  // ============================================================
  // BREAKEVEN & PAYBACK
  // ============================================================

  /**
   * Breakeven daily rate: the ADR needed to cover all costs.
   * Method: (annualized expenses + annualized depreciation) / annualized rental days.
   * Falls back to lifeExp / daysRented if years-owned data is unavailable.
   *
   * Returns null if insufficient data.
   */
  function breakevenDailyRate({ lifeExp, annualDepDollars, yearsOwned, daysRented }) {
    if (daysRented <= 0) return null;
    if (yearsOwned && yearsOwned > 0) {
      const annualExp        = lifeExp / yearsOwned;
      const annualDep        = annualDepDollars || 0;
      const annualDaysRented = daysRented / yearsOwned;
      if (annualDaysRented > 0) return (annualExp + annualDep) / annualDaysRented;
    }
    if (lifeExp > 0) return lifeExp / daysRented;
    return null;
  }

  /**
   * Payback period — months until cumulative cash profit covers purchase price.
   *
   * Returns {
   *   paybackMonths: number|null,
   *   paybackProgress: number,   // 0–1
   *   paybackPaidBack: boolean
   * }
   */
  function paybackPeriod({ profit, purchase, monthsOwned }) {
    if (!purchase || purchase <= 0) {
      return { paybackMonths: null, paybackProgress: null, paybackPaidBack: false };
    }
    const paybackProgress = Math.max(0, Math.min(1, profit / purchase));
    const avgMonthlyProfit = (monthsOwned && monthsOwned > 0) ? profit / monthsOwned : null;

    if (profit >= purchase) {
      const paybackMonths = (avgMonthlyProfit && avgMonthlyProfit > 0) ? purchase / avgMonthlyProfit : null;
      return { paybackMonths, paybackProgress, paybackPaidBack: true, avgMonthlyProfit };
    }
    if (avgMonthlyProfit && avgMonthlyProfit > 0) {
      return { paybackMonths: purchase / avgMonthlyProfit, paybackProgress, paybackPaidBack: false, avgMonthlyProfit };
    }
    return { paybackMonths: null, paybackProgress, paybackPaidBack: false, avgMonthlyProfit };
  }


  // ============================================================
  // PER-CAR COMPREHENSIVE METRICS
  // ============================================================

  /**
   * Full metrics object for a single car.
   *
   * @param {object} c         - car record
   * @param {Array}  trips     - all trips (filtered internally by carId)
   * @param {Array}  expenses  - raw expense records
   * @param {Array}  cars      - all car records (for loan expansion)
   * @returns {object} all computed metrics for the car
   */
  function carMetrics(c, trips, expenses, cars) {
    const today = new Date();
    const carTrips    = trips.filter(t => t.carId === c.id);
    const expandedExp = expandExpenses(expenses, cars || [], null, today).filter(e => e.carId === c.id);

    const daysRented = carTrips.reduce((s, t) => s + (Number(t.tripDays) || 0), 0);
    const lifeEarn   = carTrips.reduce((s, t) => s + (Number(t.earnings) || 0), 0);
    const lifeExp    = expandedExp.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const tripDates = carTrips.map(t => parseDateLoose(t.start)).filter(Boolean).sort((a, b) => a - b);
    const purchaseD = c.purchaseDate ? parseDateLoose(c.purchaseDate) : (tripDates[0] || null);
    const endD      = c.saleDate ? parseDateLoose(c.saleDate) : today;
    const daysInFleet = (purchaseD && endD) ? Math.max(1, Math.round((endD - purchaseD) / (1000 * 60 * 60 * 24))) : null;

    const utilization = utilizationRate(daysRented, daysInFleet);
    const adr         = averageDailyRate(lifeEarn, daysRented);
    const avgTripLen  = carTrips.length > 0 ? daysRented / carTrips.length : null;

    // Miles per rental day
    let totalGuestMiles = 0, daysForMiles = 0, tripsWithMiles = 0;
    for (const t of carTrips) {
      let miles = Number(t.distance) || 0;
      if (!miles && t.odometerStart && t.odometerEnd && t.odometerEnd > t.odometerStart) {
        miles = t.odometerEnd - t.odometerStart;
      }
      if (miles > 0 && t.tripDays > 0) {
        totalGuestMiles += miles;
        daysForMiles    += t.tripDays;
        tripsWithMiles++;
      }
    }
    const milesPerRentalDay = daysForMiles > 0 ? totalGuestMiles / daysForMiles : null;

    // Depreciation
    const purchase = Number(c.purchasePrice) || 0;
    const resale   = carResaleValue(c);
    const yearsOwned = purchaseD ? (endD - purchaseD) / (1000 * 60 * 60 * 24 * 365.25) : null;

    let depreciationTotal = null, annualDepDollars = null, annualDepPct = null;
    if (purchase > 0 && resale > 0 && yearsOwned && yearsOwned > 0) {
      depreciationTotal = purchase - resale;
      annualDepDollars  = depreciationTotal / yearsOwned;
      const ratio = resale / purchase;
      if (ratio > 0) annualDepPct = (1 - Math.pow(ratio, 1 / yearsOwned)) * 100;
    }

    const be = breakevenDailyRate({ lifeExp, annualDepDollars, yearsOwned, daysRented });
    const monthsOwned = yearsOwned ? yearsOwned * 12 : null;
    const profit = lifeEarn - lifeExp;
    const pb = paybackPeriod({ profit, purchase, monthsOwned });

    return {
      trips: carTrips,
      expenses: expandedExp,
      daysRented,
      lifeEarn,
      lifeExp,
      daysInFleet,
      purchaseD,
      endD,
      utilization,
      adr,
      avgTripLen,
      yearsOwned,
      monthsOwned,
      avgMonthlyProfit: pb.avgMonthlyProfit || null,
      depreciationTotal,
      annualDepDollars,
      annualDepPct,
      breakevenDaily: be,
      purchase,
      resale,
      profit,
      netReturn: profit + resale - purchase,
      paybackMonths: pb.paybackMonths,
      paybackProgress: pb.paybackProgress,
      paybackPaidBack: pb.paybackPaidBack,
      totalGuestMiles,
      milesPerRentalDay,
      tripsWithMiles,
    };
  }


  // ============================================================
  // FLEET-LEVEL AGGREGATE METRICS
  // ============================================================

  /**
   * Fleet net worth:
   * activeCarValues + netCashFlow − activeCarInvestment
   *
   * Returns { netWorth, activeValue, netCashFlow, activeInvested }
   */
  function fleetNetWorth(cars, trips, expenses) {
    const today = new Date();
    const active         = activeCars(cars);
    const expandedExp    = expandExpenses(expenses, cars, null, today);
    const activeValue    = active.reduce((s, c) => s + (Number(c.currentValue) || 0), 0);
    const activeInvested = active.reduce((s, c) => s + (Number(c.purchasePrice) || 0), 0);
    const lifetimeEarn   = cars.reduce((s, c) => s + trips.filter(t => t.carId === c.id).reduce((a, t) => a + (Number(t.earnings) || 0), 0), 0);
    const lifetimeExp    = cars.reduce((s, c) => s + expandedExp.filter(e => e.carId === c.id).reduce((a, e) => a + (Number(e.amount) || 0), 0), 0);
    const netCashFlow    = lifetimeEarn - lifetimeExp;
    return {
      netWorth: activeValue + netCashFlow - activeInvested,
      activeValue,
      netCashFlow,
      activeInvested,
    };
  }

  /**
   * Aggregate fleet utilization: total days rented / total days in fleet.
   * perCarMetrics: array of carMetrics() results.
   */
  function fleetUtilization(perCarMetrics) {
    const totalDaysFleet  = perCarMetrics.reduce((s, m) => s + (m.daysInFleet || 0), 0);
    const totalDaysRented = perCarMetrics.reduce((s, m) => s + (m.daysRented || 0), 0);
    return totalDaysFleet > 0 ? (totalDaysRented / totalDaysFleet) * 100 : null;
  }

  /**
   * Revenue trend: compare last 3 months earnings vs prior 3 months.
   * Returns { trendPct, trendDirection } where direction is 'accelerating' | 'stable' | 'slowing' | 'unknown'.
   */
  function revenueTrend(trips) {
    const today  = new Date();
    const m3     = new Date(today.getFullYear(), today.getMonth() - 3, 1);
    const m6     = new Date(today.getFullYear(), today.getMonth() - 6, 1);
    let recent3  = 0, prior3 = 0;
    for (const t of trips) {
      const d = parseDateLoose(t.start);
      if (!d) continue;
      if (d >= m3 && d <= today) recent3 += Number(t.earnings) || 0;
      else if (d >= m6 && d < m3) prior3 += Number(t.earnings) || 0;
    }
    const trendPct = prior3 > 0 ? ((recent3 - prior3) / prior3) * 100 : null;
    const trendDirection = trendPct === null ? 'unknown'
      : trendPct > 5  ? 'accelerating'
      : trendPct < -5 ? 'slowing'
      : 'stable';
    return { trendPct, trendDirection, recent3, prior3 };
  }

  /**
   * Revenue consistency: coefficient of variation (%) over the last 6 months.
   * Lower CV = more stable. Returns { cv, stddev, mean, stabilityLabel }.
   */
  function revenueConsistency(trips) {
    const today = new Date();
    const monthlyRev = [];
    for (let i = 5; i >= 0; i--) {
      const m    = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const mEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0);
      let v = 0;
      for (const t of trips) {
        const d = parseDateLoose(t.start);
        if (d && d >= m && d <= mEnd) v += Number(t.earnings) || 0;
      }
      monthlyRev.push(v);
    }
    const mean     = monthlyRev.reduce((s, v) => s + v, 0) / Math.max(1, monthlyRev.length);
    const variance = monthlyRev.reduce((s, v) => s + (v - mean) * (v - mean), 0) / Math.max(1, monthlyRev.length);
    const stddev   = Math.sqrt(variance);
    const cv       = mean > 0 ? (stddev / mean) * 100 : 0;
    const stabilityLabel = cv < 15 ? 'Very stable' : cv < 30 ? 'Stable' : cv < 50 ? 'Volatile' : 'Highly volatile';
    return { cv, stddev, mean, stabilityLabel, monthlyRev };
  }


  // ============================================================
  // SCALING READINESS SCORE
  // ============================================================

  /**
   * Score a single signal on a 0–25 scale using linear interpolation
   * between baseline (0 pts) and ideal (25 pts).
   */
  function scoreSignal(value, ideal, baseline) {
    if (value === null || value === undefined || isNaN(value)) return 0;
    const pct = (value - baseline) / (ideal - baseline);
    return Math.max(0, Math.min(25, pct * 25));
  }

  /**
   * Overall fleet scaling readiness score (0–100).
   * Composed of four signals, each worth up to 25 pts:
   *   1. Fleet utilization  (ideal: 75%, baseline: 30%)
   *   2. Weighted avg ROI   (ideal: 25%, baseline: 0%)
   *   3. Profit margin      (ideal: 30%, baseline: 0%)
   *   4. Revenue trend      (ideal: +20%, baseline: -10%)
   *
   * Returns { score, signals: { util, roi, margin, trend } }
   */
  function scalingReadinessScore({ avgUtil, avgAnnualRoiPct, margin, trendPct }) {
    const utilScore   = scoreSignal(avgUtil,       75,  30);
    const roiScore    = scoreSignal(avgAnnualRoiPct, 25,  0);
    const marginScore = scoreSignal(margin,        30,   0);
    const trendScore  = scoreSignal(trendPct,      20, -10);
    const score       = utilScore + roiScore + marginScore + trendScore;
    return { score, signals: { util: utilScore, roi: roiScore, margin: marginScore, trend: trendScore } };
  }


  // ============================================================
  // FLEET SCALING PROJECTIONS
  // ============================================================

  /**
   * Projects annual profit at a target fleet size, accounting for:
   * - Utilization decay (each added car reduces util by utilDecay %)
   * - Efficiency loss (5 % per car beyond soloCapacity)
   * - Staffing costs (cleaner + co-host)
   * - Accident costs
   *
   * @param {object} params
   * @param {number} params.targetSize        - fleet size to project
   * @param {number} params.currentCarCount
   * @param {number} params.annualProfitPerCar
   * @param {number} params.annualRevenuePerCar
   * @param {number} params.avgUtil            - current utilization %
   * @param {number} params.monthlyCleanerCost - cost per month at current fleet size
   * @param {number} params.cleanerNeededAt    - fleet size at which cleaner becomes needed
   * @param {object} params.assume             - assumption overrides (from getScAssumptions shape)
   * @returns { grossProfit, cohostCost, cleanerCost, accidentCost, netProfit, hours }
   */
  function scalingProjection(params) {
    const {
      targetSize,
      currentCarCount,
      annualProfitPerCar,
      annualRevenuePerCar,
      avgUtil,
      monthlyCleanerCost,
      cleanerNeededAt,
      assume,
    } = params;

    const { soloCapacity, cohostMonthly, accidentRate, accidentCost, utilDecay, hoursPerBooking } = assume;

    const utilN           = Math.max(20, (avgUtil || 60) - (targetSize - currentCarCount) * utilDecay);
    const efficiencyLoss  = Math.max(0, (targetSize - soloCapacity) * 5);
    const profitFactor    = (1 - efficiencyLoss / 100) * (utilN / Math.max(1, avgUtil || 60));
    const grossProfit     = annualProfitPerCar * targetSize * profitFactor;

    const cohostCost   = targetSize > soloCapacity ? cohostMonthly * 12 : 0;
    const cleanerCost  = targetSize >= cleanerNeededAt
      ? monthlyCleanerCost * (targetSize / Math.max(1, currentCarCount)) * 12
      : 0;
    const accidentCostTotal = (accidentRate / 100) * targetSize * accidentCost;
    const netProfit    = grossProfit - cohostCost - cleanerCost - accidentCostTotal;
    const revenue      = annualRevenuePerCar * targetSize;

    return { grossProfit, cohostCost, cleanerCost, accidentCost: accidentCostTotal, netProfit, revenue, projectedUtil: utilN, efficiencyLoss };
  }

  /**
   * Sweep fleet sizes 1–50 to find the size that maximises net profit,
   * profit per hour, and work/life balance.
   * Returns { bestProfitSize, bestProfitAmount, bestFreeTimeSize, bestBalanceSize }
   */
  function optimalFleetSize(params) {
    const {
      currentCarCount,
      annualProfitPerCar,
      avgUtil,
      monthlyCleanerCost,
      cleanerNeededAt,
      hoursPerCarPerWeek,
      assume,
    } = params;
    const { soloCapacity, cohostMonthly, accidentRate, accidentCost, utilDecay, hoursAvailable } = assume;

    let bestProfitSize = 1, bestProfit = -Infinity;
    let bestBalanceSize = 1, bestBalance = -Infinity;
    let bestFreeTimeSize = 1, bestFreeTime = -Infinity;

    for (let n = 1; n <= 50; n++) {
      const utilN          = Math.max(20, (avgUtil || 60) - (n - currentCarCount) * utilDecay);
      const efficiencyLoss = Math.max(0, (n - soloCapacity) * 5);
      const profitFactor   = (1 - efficiencyLoss / 100) * (utilN / Math.max(1, avgUtil || 60));
      const grossProfit    = annualProfitPerCar * n * profitFactor;
      const cohostCost     = n > soloCapacity ? cohostMonthly * 12 : 0;
      const cleanerCost    = n >= cleanerNeededAt ? monthlyCleanerCost * (n / Math.max(1, currentCarCount)) * 12 : 0;
      const accCost        = (accidentRate / 100) * n * accidentCost;
      const netProfit      = grossProfit - cohostCost - cleanerCost - accCost;
      const hours_n        = n * hoursPerCarPerWeek - (n > soloCapacity ? n * hoursPerCarPerWeek * 0.5 : 0);

      if (netProfit > bestProfit) { bestProfit = netProfit; bestProfitSize = n; }
      const balanceScore = netProfit - (hours_n > hoursAvailable ? (hours_n - hoursAvailable) * 200 : 0);
      if (balanceScore > bestBalance) { bestBalance = balanceScore; bestBalanceSize = n; }
      const freeTimeScore = netProfit / Math.max(1, hours_n);
      if (freeTimeScore > bestFreeTime) { bestFreeTime = freeTimeScore; bestFreeTimeSize = n; }
    }
    return { bestProfitSize, bestProfitAmount: bestProfit, bestFreeTimeSize, bestBalanceSize };
  }

  /**
   * Operational capacity: maximum cars manageable solo given time constraints.
   * maxSolo = hoursAvailable / hoursPerCarPerWeek
   */
  function soloManagementCapacity(hoursAvailable, hoursPerCarPerWeek) {
    return hoursPerCarPerWeek > 0 ? Math.floor(hoursAvailable / hoursPerCarPerWeek) : null;
  }

  /**
   * Debt-to-revenue ratio and financial risk label.
   * Returns { ratio, label: 'Low'|'Moderate'|'High' }
   */
  function debtToRevenueRisk(annualLoanObligations, annualRevenue) {
    const ratio = annualRevenue > 0 ? (annualLoanObligations / annualRevenue) * 100 : 0;
    const label = ratio < 25 ? 'Low' : ratio < 50 ? 'Moderate' : 'High';
    return { ratio, label };
  }

  /**
   * Fleet downtime from accidents as a percentage of total available days.
   * Assumes ~14 days off-fleet per accident.
   */
  function accidentDowntimePct(accidentRatePct, carCount) {
    const expectedAccidents   = (accidentRatePct / 100) * carCount;
    const downtimeDaysPerYear = expectedAccidents * 14;
    const pct                 = carCount > 0 ? (downtimeDaysPerYear / (carCount * 365)) * 100 : 0;
    return { pct, downtimeDaysPerYear, expectedAccidents };
  }


  // ============================================================
  // SMART METRICS — VEHICLE TYPE ANALYSIS
  // ============================================================

  const LUXURY_MAKES = new Set([
    'porsche','bmw','mercedes','mercedes-benz','audi','lexus','tesla',
    'range rover','land rover','jaguar','acura','infiniti','cadillac',
    'lincoln','genesis','bentley','maserati','aston martin','rolls-royce',
    'rolls royce','alfa romeo','volvo',
  ]);
  const SPORTS_KEYWORDS = [
    'gt','r8','911','718','corvette','mustang','camaro','challenger',
    'charger','m3','m4','m5','amg','rs','sport','spider','spyder',
  ];

  /**
   * Classify a car into a vehicle type string.
   * Returns one of: 'Luxury' | 'Sports' | 'EV / Hybrid' | 'Truck' | 'SUV' | 'Coupe' | 'Sedan' | 'Other'
   */
  function classifyCar(c) {
    const make     = (c.makeModel || '').split(' ')[0]?.toLowerCase() || '';
    const mm       = (c.makeModel || '').toLowerCase();
    const body     = (c.bodyClass || '').toLowerCase();
    const isLuxury = LUXURY_MAKES.has(make) || [...LUXURY_MAKES].some(b => mm.startsWith(b));
    const isSports = SPORTS_KEYWORDS.some(k => mm.includes(k));
    const isSuv    = body.includes('sport utility') || body.includes('mpv') || body.includes('suv')
      || /\bsuv\b/.test(mm)
      || /(blazer|bronco|jeep|tahoe|suburban|expedition|explorer|cherokee|wrangler|4runner|highlander|pilot|pathfinder|rav4|equinox|escape|edge|rogue|cr-v|crv|telluride|palisade|ascent|trax)/i.test(mm);
    const isTruck  = body.includes('truck') || body.includes('pickup')
      || /(f-150|f150|silverado|sierra|ram|ranger|colorado|tacoma|tundra|frontier|titan|maverick)/i.test(mm);
    const isCoupe  = body.includes('coupe') || body.includes('convertible');
    const isSedan  = body.includes('sedan') || body.includes('saloon') || (!isSuv && !isTruck && !isCoupe);
    const isEv     = (c.fuelType || '').toLowerCase().includes('electric')
      || /(taycan|model [3sxy]|leaf|bolt|mach-e|ioniq|ev6|lucid|rivian)/i.test(mm);

    if (isLuxury) return 'Luxury';
    if (isSports) return 'Sports';
    if (isEv)     return 'EV / Hybrid';
    if (isTruck)  return 'Truck';
    if (isSuv)    return 'SUV';
    if (isCoupe)  return 'Coupe';
    if (isSedan)  return 'Sedan';
    return 'Other';
  }

  /**
   * Aggregate performance stats per vehicle type.
   * typeGroups: { [type]: car[] } — use classifyCar() to build this.
   * Returns array of type-stat objects sorted by avgRoi descending.
   */
  function vehicleTypeStats(typeGroups, trips, expenses, cars) {
    return Object.entries(typeGroups).map(([type, list]) => {
      const metrics  = list.map(c => ({ car: c, m: carMetrics(c, trips, expenses, cars), roi: carRoi(c, trips, expenses, cars) }));
      const totalEarn = metrics.reduce((s, x) => s + x.m.lifeEarn, 0);
      const totalExp  = metrics.reduce((s, x) => s + x.m.lifeExp,  0);
      const totalDaysFleet  = metrics.reduce((s, x) => s + (x.m.daysInFleet || 0), 0);
      const totalDaysRented = metrics.reduce((s, x) => s + (x.m.daysRented  || 0), 0);
      const profit    = totalEarn - totalExp;
      const avgUtil   = totalDaysFleet > 0 ? (totalDaysRented / totalDaysFleet) * 100 : null;
      const avgAdr    = totalDaysRented > 0 ? totalEarn / totalDaysRented : null;
      let weightedRoi = 0, weight = 0;
      for (const x of metrics) {
        if (x.roi && x.car.purchasePrice) { weightedRoi += x.roi.annualPct * x.car.purchasePrice; weight += x.car.purchasePrice; }
      }
      const avgRoi           = weight > 0 ? weightedRoi / weight : null;
      const profitPerCar     = list.length > 0 ? profit / list.length : 0;
      const revPerFleetDay   = avgAdr !== null && avgUtil !== null ? avgAdr * (avgUtil / 100) : null;
      return { type, count: list.length, list, totalEarn, profit, avgUtil, avgAdr, avgRoi, profitPerCar, revenuePerFleetDay: revPerFleetDay };
    }).sort((a, b) => {
      const aR = a.avgRoi !== null ? a.avgRoi : -999;
      const bR = b.avgRoi !== null ? b.avgRoi : -999;
      if (aR !== bR) return bR - aR;
      return b.profitPerCar - a.profitPerCar;
    });
  }

  /**
   * Bin cars by ADR into price bands and compute avg utilization + revenue/fleet-day.
   * Returns array of band objects with { label, min, max, count, avgUtil, avgAdr, avgRevPerDay }.
   * Also returns the optimal (highest revPerFleetDay) populated band.
   */
  function adrBandAnalysis(carPoints) {
    // carPoints: array of { adr, util, revPerFleetDay, ... }
    const bands = [
      { label: '$30–50/day',   min: 0,   max: 50  },
      { label: '$50–75/day',   min: 50,  max: 75  },
      { label: '$75–100/day',  min: 75,  max: 100 },
      { label: '$100–150/day', min: 100, max: 150 },
      { label: '$150+/day',    min: 150, max: Infinity },
    ];
    const bandStats = bands.map(b => {
      const inBand = carPoints.filter(p => p.adr >= b.min && p.adr < b.max);
      const avgUtil       = inBand.length > 0 ? inBand.reduce((s, p) => s + p.util, 0)           / inBand.length : null;
      const avgAdr        = inBand.length > 0 ? inBand.reduce((s, p) => s + p.adr,  0)           / inBand.length : null;
      const avgRevPerDay  = inBand.length > 0 ? inBand.reduce((s, p) => s + p.revPerFleetDay, 0) / inBand.length : null;
      return { ...b, count: inBand.length, avgUtil, avgAdr, avgRevPerDay };
    });
    const populated = bandStats.filter(b => b.count > 0);
    const optimal   = populated.length > 0 ? populated.reduce((best, b) => (b.avgRevPerDay || 0) > (best.avgRevPerDay || 0) ? b : best, populated[0]) : null;
    return { bandStats, optimal };
  }


  // ============================================================
  // OPERATIONAL BOTTLENECK ANALYSIS
  // ============================================================

  /**
   * Categorise an expense into a bottleneck category.
   * Returns 'cleaning' | 'delivery' | 'maintenance' | null.
   */
  function bottleneckCategoryFor(e) {
    const txt = ((e.description || '') + ' ' + (e.category || '')).toLowerCase();
    if (/(clean|wash|detail|vacuum|car wash)/.test(txt))                                                  return 'cleaning';
    if (/(deliver|transport|tow|uber|lyft|rideshare|trailer)/.test(txt))                                  return 'delivery';
    if (/(maint|oil|tire|brake|service|inspect|repair|fluid|filter|battery|alternator|transmission|spark|wiper|engine|coolant|belt|fix|mechanic)/.test(txt)) return 'maintenance';
    return null;
  }

  /**
   * Returns bottleneck totals and % of revenue for cleaning, delivery, and maintenance.
   * expandedExpenses: output of expandExpenses() for a 12-month window.
   * rawExpenses: the original state.expenses array (for category matching).
   */
  function bottleneckTotals(expandedExpenses, rawExpenses, totalRevenue, tripCount12mo, carCount) {
    const bins = { cleaning: 0, delivery: 0, maintenance: 0 };
    for (const e of expandedExpenses) {
      if (e.type === 'loan') continue;
      const original = rawExpenses.find(se => se.carId === e.carId && se.amount === e.amount && se.description === e.description) || e;
      const cat = bottleneckCategoryFor(original);
      if (cat) bins[cat] += e.amount;
    }
    const pct = (amount) => totalRevenue > 0 ? (amount / totalRevenue) * 100 : 0;
    return {
      cleaning:    { total: bins.cleaning,    pct: pct(bins.cleaning),    perTrip: tripCount12mo > 0 ? bins.cleaning    / tripCount12mo : 0 },
      delivery:    { total: bins.delivery,    pct: pct(bins.delivery),    perTrip: tripCount12mo > 0 ? bins.delivery    / tripCount12mo : 0 },
      maintenance: { total: bins.maintenance, pct: pct(bins.maintenance), perCar:  carCount      > 0 ? bins.maintenance / carCount      : 0 },
    };
  }

  /**
   * Status label for a bottleneck percentage.
   * Returns { label: 'Low'|'Moderate'|'High', color: 'emerald'|'amber'|'rose' }
   */
  function bottleneckStatus(pct, low, high) {
    if (pct < low)  return { label: 'Low',      color: 'emerald' };
    if (pct < high) return { label: 'Moderate', color: 'amber'   };
    return { label: 'High', color: 'rose' };
  }

  /**
   * Smart-scale projection: annual profit × fleet size (no workload modelling).
   * Returns { profit, monthlyProfit, capital, roi }
   */
  function smartScaleProjection(avgProfitPerCar, avgInvestPerCar, fleetSize) {
    const profit   = avgProfitPerCar * fleetSize;
    const capital  = avgInvestPerCar * fleetSize;
    const roi      = capital > 0 ? (profit / capital) * 100 : null;
    return { profit, monthlyProfit: profit / 12, capital, roi };
  }


  // ============================================================
  // PUBLIC API
  // ============================================================

  return {
    // Formatting
    fmt$,
    fmt$2,

    // Date / parsing
    parseDateLoose,
    ymKey,
    ymLabel,
    parseAmount,
    pickField,
    guessYear,
    guessMakeModel,

    // Loan
    calculateLoanPayment,
    loanOutstandingBalance,
    loanPaymentsInRange,

    // Depreciation & value
    depreciationFactorForYears,
    estimateCurrentValue,
    carResaleValue,

    // Expenses
    expandExpenses,

    // Date ranges
    rangeBounds,
    totalEarnings,
    totalExpenses,
    tripCount,

    // Car status
    isSold,
    activeCars,
    carDisplayName,
    getCarLatestMileage,
    getCarFirstTripDate,
    getCarLastTripDate,

    // ROI
    carRoi,
    avgAnnualRoi,
    fleetRoi,

    // Utilization & ADR
    utilizationRate,
    averageDailyRate,
    revenuePerFleetDay,

    // Breakeven & payback
    breakevenDailyRate,
    paybackPeriod,

    // Per-car metrics
    carMetrics,

    // Fleet aggregates
    fleetNetWorth,
    fleetUtilization,
    revenueTrend,
    revenueConsistency,

    // Scaling readiness
    scoreSignal,
    scalingReadinessScore,

    // Scaling projections
    scalingProjection,
    optimalFleetSize,
    soloManagementCapacity,
    debtToRevenueRisk,
    accidentDowntimePct,

    // Smart metrics / type analysis
    classifyCar,
    vehicleTypeStats,
    adrBandAnalysis,

    // Operational bottlenecks
    bottleneckCategoryFor,
    bottleneckTotals,
    bottleneckStatus,
    smartScaleProjection,
  };

})();
