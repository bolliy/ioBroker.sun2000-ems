'use strict';

/**
 * Checks if the given adapter is alive.
 *
 * @param {ioBroker.Adapter} adapter an instance of the ioBroker Adapter
 * @param {string} adapterName the name of the adapter
 * @param {number} intanceNumber the instance number of the adapter
 * @returns {Promise<boolean>} true if the adapter is alive, false otherwise
 */
async function adapterAlive(adapter, adapterName, intanceNumber) {
	const state = await adapter.getStateAsync(`system.${adapterName}.${intanceNumber.toString()}.alive`);
	if (state) {
		return state.val === true;
	}

	return false;
}

function toDateString(date) {
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return `${date.getFullYear()}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date
		.getMinutes()
		.toString()
		.padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
}

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
			pvFcArray.push({ total: Math.round(value), time: toDateString(dt) });
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
			if (!(await adapterAlive(this.adapter, 'pvforecast', 0))) {
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
