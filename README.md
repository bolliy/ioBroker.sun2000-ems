![Logo](admin/sun2000-ems.png)
# ioBroker.sun2000-ems

[![NPM version](https://img.shields.io/npm/v/iobroker.sun2000-ems.svg)](https://www.npmjs.com/package/iobroker.sun2000-ems)
[![Downloads](https://img.shields.io/npm/dm/iobroker.sun2000-ems.svg)](https://www.npmjs.com/package/iobroker.sun2000-ems)
![Number of Installations](https://iobroker.live/badges/sun2000-ems-installed.svg)
![Current version in stable repository](https://iobroker.live/badges/sun2000-ems-stable.svg)

[![NPM](https://nodei.co/npm/iobroker.sun2000-ems.png?downloads=true)](https://nodei.co/npm/iobroker.sun2000-ems/)

**Tests:** ![Test and Release](https://github.com/bolliy/ioBroker.sun2000-ems/workflows/Test%20and%20Release/badge.svg)

## sun2000-ems adapter for ioBroker

forecast based battery charging using the sun2000 adapter

!! THIS ADAPTER IS STILL REPRESENTING AN DEVELOPMENT STATE !!!

Is a ioBroker adapter that provides a **Solar Inverter (Sun2000) Home Energy Management System (EMS)**. It works with the **Sun2000** inverter and **Tibber** for price data.

## Features

- **Battery management** – Optimizes charging and discharging based on forecasted solar production and electricity prices.
- **Price‑aware charging** – Uses Tibber price data to schedule charging when electricity is cheap.
- **Grid‑friendly feed‑in** – Adjusts surplus feed‑in to avoid over‑loading the grid.
- **Automatic load handling** – Balances load and battery usage to keep the system within inverter limits.
- **Configurable thresholds** – Allows setting of charge/discharge cut‑off capacities.

## Usage

The adapter creates several states under `sun2000.0`:

- `inverter.*` – Current inverter status, voltage, current, etc.
- `battery.*` – Battery state of charge, charge/discharge power, and limits.
- `prices.*` – Latest Tibber price information.
- `control.*` – Commands to start/stop charging, set limits, etc.

The EMS runs a minute‑based loop that:

1. Reads current load, PV production, and battery state.
2. Simulates future SOC based on forecasted PV.
3. Determines a safe minimum SOC (`surplusMinSoc`) using a clamped calculation with a 1 % safety margin.
4. Sets the inverter’s surplus‑min‑SOC and buffer‑SOC values.
5. Adjusts charging/discharging according to price thresholds and inverter limits.

## Changelog
<!--
	Placeholder for the next version (at the beginning of the line):
	### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**
* (bolliy) initial release
* Refactored surplus‑SOC logic:
  - Added a `clamp` helper function for safe value limits.
  - Introduced `SURPLUS_OFFSET` (1 % safety margin).
  - Calculated `surplusMinSoc` using `clamp` with clear naming.
  - Removed duplicate `setSurplusMinSoc` call.
  - Unified and clarified comments (e.g., “Plausibility clamps for the buffer SOC”).
- Fixed typo `suplusMinSoc` → `surplusMinSoc`.
- Cleaned up irregular whitespace and tabs, eliminating ESLint errors.
- Improved overall code readability and maintainability.

## License
MIT License

Copyright (c) 2026 bolliy <stephan@mante.info>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
