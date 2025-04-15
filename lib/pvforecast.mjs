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
		for (let h = 5; h < 22; h++) {
			let hour = h.toString();
			hour = `${hour.padStart(2, '0')}:00:00`;
			const state = await this.adapter.getStateAsync(path + hour);
			if (state) {
				pushItem(h, state.val, dt);
				//pushItem(h, 0 ,dt);
			}
		}
	}

	async loadPvForcast() {
		const pvFcArray = [];
		try {
			this.adapter.log.info('PVForecast loading ...');
			if (!(await tools.adapterAlive(this.adapter, 'pvforecast', 0))) {
				this.adapter.log.info('PVForecast not alive');
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

	get jsonData() {
		return this.jsonArray;
	}

	async update() {
		this.jsonArray = await this.loadPvForcast();
	}
} //of Forecast

export default PVForecast;
