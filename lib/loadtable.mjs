'use strict';

import * as tools from './tools.mjs';
import Pvforecast from './pvforecast.mjs';

class LoadTable {
	/**
	 * Constructor of LoadTable
	 * @param {ioBroker.Adapter} adapterInstance - the ioBroker adapter instance
	 */
	constructor(adapterInstance) {
		this.adapter = adapterInstance;
		this.jsonArray = [];
		this.cPVForecast = new Pvforecast(adapterInstance);
	}

	/**
	 * Calculates the load table based on the provided PV forecast data.
	 *
	 * @param {Array} pvForcast - An array of objects containing PV forecast data with time and total energy production.
	 * @returns {Array} Returns an array of objects representing the load table. Each object includes:
	 *   - idx: The index representing the hourly intervals.
	 *   - consumption: The energy consumption value for the interval.
	 *   - pv: The forecasted PV production for the interval.
	 *   - balance: The cumulative energy balance up to the interval.
	 *   - lockCharging: A flag indicating whether charging is locked.
	 *   - lockDischarging: A flag indicating whether discharging is locked.
	 *   - time: The string representation of the date and time for the interval.
	 */
	_calculateLoadTable(pvForcast) {
		const load = [];
		const dayConsumption = 650;
		const nightConsumption = 100;
		let consumption;
		const dt0 = new Date();
		if (pvForcast[0].time == null) return load;

		let dt = new Date(pvForcast[0].time);
		for (let h = 0; h < 48; h++) {
			if (h === 24) dt.setDate(dt0.getDate() + 1); //next day
			if (h >= 24) {
				dt.setHours(h - 24);
			} else {
				dt.setHours(h);
			}
			const hh = dt.getHours();

			if (hh >= 7 && hh <= 22) {
				consumption = dayConsumption;
			} else {
				consumption = nightConsumption;
			}
			//console.log(dt.toDateString()+', '+toDateString(dt));

			load.push({
				idx: h,
				consumption: consumption,
				pv: 0,
				balance: 0,
				lockCharging: false,
				lockDischarging: false,
				time: tools.toDateString(dt),
			});
		}

		for (let h = 0; h < pvForcast.length; h++) {
			dt = new Date(pvForcast[h].time);
			let hh = new Date(pvForcast[h].time).getHours();

			if (dt.getDate() != dt0.getDate()) {
				hh += 24;
			}
			//console.log('pvforcast '+hh+' total '+pvForcast[h].total+ ' date '+dt.getDate());
			load[hh].pv = pvForcast[h].total;
		}

		let balance = 0;
		for (let h = 0; h < load.length; h++) {
			balance += load[h].pv - load[h].consumption;
			load[h].balance = balance;
		}

		return load;
	}

	/**
	 * Get the current state of the load table as JSON.
	 *
	 * @returns {object[]} The current load table as an array of objects.
	 * - {number} idx - The index of the hour of day.
	 * - {number} consumption - The consumption in Wh for the given hour.
	 * - {number} pv - The PV production in Wh for the given hour.
	 * - {number} balance - The current balance in Wh.
	 * - {boolean} lockCharging - Is charging locked for the given hour?
	 * - {boolean} lockDischarging - Is discharging locked for the given hour?
	 * - {string} time - The time of day in the format `YYYY-MM-DDTHH:MM:00.000Z`.
	 */
	get jsonData() {
		return this.jsonArray;
	}

	/**
	 * Updates the load table with the latest data from the pv forecast.
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async update() {
		await this.cPVForecast.update();
		this.jsonArray = this._calculateLoadTable(this.cPVForecast.jsonData);
	}
} //of LoadTable

export default LoadTable;
