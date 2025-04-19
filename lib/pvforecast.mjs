'use strict';

import * as tools from './tools.mjs';

class PVForecast {
	/**
	 * Creates a new PVForecast instance.
	 *
	 * @param {ioBroker.Adapter} adapterInstance - the ioBroker adapter instance
	 */
	constructor(adapterInstance) {
		this.adapter = adapterInstance;
		this.jsonArray = [];
	}

	async _getEnergyData(pvFcArray, addDate) {
		function pushItem(h, value, dt) {
			dt.setHours(h, 0, 0);
			pvFcArray.push({ total: Math.round(value), time: tools.toDateString(dt) });
		}

		let path;
		const dt = new Date();

		if (addDate == 0) {
			path = 'pvforecast.0.summary.energy.hoursToday.';
		} else {
			path = 'pvforecast.0.summary.energy.hoursTomorrow.';
			dt.setDate(dt.getDate() + addDate);
		}
		let factor = 0;

		for (let h = 5; h < 22; h++) {
			let hour = h.toString();
			hour = `${hour.padStart(2, '0')}:00:00`;
			if (factor == 0) {
				const obj = await this.adapter.getForeignObjectAsync(path + hour);
				if (obj?.common.unit == 'kWh') factor = 1000;

				if (obj?.common.unit == 'Wh') {
					factor = 1;
				}
			}

			const state = await this.adapter.getForeignStateAsync(path + hour);
			//this.adapter.log.info(`PVForecast1: ${path + hour} ${JSON.stringify(state)}`);
			if (state) {
				if (tools.isNumber(state.val)) {
					// @ts-expect-error : Unreachable code error
					pushItem(h, state.val * factor, dt);
				}
				//pushItem(h, 0 ,dt);
			}
		}
	}

	async _loadPvForcast() {
		const pvFcArray = [];
		try {
			this.adapter.log.info('PVForecast loading ...');
			const ret = await tools.adapterAlive(this.adapter, 'pvforecast', 0);
			if (ret.exist) {
				if (!ret.alive) {
					this.adapter.log.warn('PVForecast not alive');
				}
			} else {
				this.adapter.log.warn('PVForecast not exist!');
			}
			await this._getEnergyData(pvFcArray, 0);
			await this._getEnergyData(pvFcArray, 1);
			//console.log('PVForecast '+JSON.stringify(pvFcArray));
			return pvFcArray;
		} catch (e) {
			console.warn(`Error load PVForecast ${e}`);
			return [];
		}
	}

	/**
	 * The current PV forecast as an array of objects.
	 * @returns {object[]} The current PV forecast as an array of objects.
	 * - {number} total - The total production in Wh for the given hour.
	 * - {string} time - The time of day in the format `YYYY-MM-DDTHH:00:00.000Z`.
	 */
	get jsonData() {
		return this.jsonArray;
	}

	/**
	 * Updates the PV forecast data by loading the latest forecast information.
	 *
	 * @async
	 * @returns {Promise<void>}
	 */
	async update() {
		this.jsonArray = await this._loadPvForcast();
	}
} //of Forecast

export default PVForecast;
