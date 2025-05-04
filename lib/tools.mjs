'use strict';

import suncalc from 'suncalc2';
//const suncalc = require('suncalc2');

function getAstroDate(adapter, pattern, date, offsetMinutes) {
	if (date === undefined) {
		date = new Date();
	}
	if (typeof date === 'number') {
		date = new Date(date);
	}

	if ((!adapter.latitude && adapter.latitude !== 0) || (!adapter.longitude && adapter.longitude !== 0)) {
		adapter.log.warn('Longitude or latitude does not set. Cannot use astro.');
		return;
	}

	// ensure events are calculated independent of current time
	date.setHours(12, 0, 0, 0);
	let ts = suncalc.getTimes(date, adapter.latitude, adapter.longitude)[pattern];

	if (ts === undefined || ts.getTime().toString() === 'NaN') {
		adapter.log.warn(`Cannot calculate astro date "${pattern}" for ${adapter.latitude}, ${adapter.longitude}`);
	}

	adapter.log.debug(`getAstroDate(pattern=${pattern}, date=${date}) => ${ts}`, 'info');

	if (offsetMinutes !== undefined) {
		ts = new Date(ts.getTime() + offsetMinutes * 60000);
	}
	return ts;
}

/**
 * Checks if a specified adapter instance is alive.
 *
 * @param {object} adapter - The ioBroker adapter instance.
 * @param {string} instanceName - The name of the adapter instance to check.
 * @returns {Promise<object>} An object with:
 *   - {boolean} exist - Indicates if the adapter instance exists.
 *   - {boolean} alive - Indicates if the adapter instance is alive.
 */
async function adapterAlive(adapter, instanceName) {
	const state = await adapter.getForeignStateAsync(`system.adapter.${instanceName}.alive`);
	return {
		exist: state !== null,
		alive: state?.val === true,
	};
}

/**
 * Converts a Date object to a string in the format "YYYY-MM-DD HH:MM:SS".
 *
 * @param {Date} date the Date object to convert
 * @returns {string} the string representation of the Date object
 */
function toDateString(date) {
	const month = date.getMonth() + 1;
	const day = date.getDate();
	return `${date.getFullYear()}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')} ${date.getHours().toString().padStart(2, '0')}:${date
		.getMinutes()
		.toString()
		.padStart(2, '0')}:${date.getSeconds().toString().padStart(2, '0')}`;
}

/**
 * Checks if the given value is a number.
 *
 * @param {*} val the value to check
 * @returns {boolean} true if val is a number, false otherwise
 */
function isNumber(val) {
	return typeof val === 'number';
}

/**
 * Retrieves the value of a state asynchronously.
 *
 * @param {ioBroker.Adapter} adapterInstance - The ioBroker adapter instance.
 * @param {string} stateName - The name of the state to retrieve.
 * @returns {Promise<*>} The value of the retrieved state.
 */
async function getStateValue(adapterInstance, stateName) {
	try {
		const state = await adapterInstance.getForeignStateAsync(stateName);
		return state?.val;
	} catch (err) {
		adapterInstance.log.error(`getStateValue(stateName=${stateName}) => ${err}`);
	}
	return;
}
//Mittelwert
class Average {
	constructor(n) {
		this._n = n;
		this._dValue = -1;
	}

	set newValue(value) {
		if (this._dValue === -1) {
			this._dValue = value;
		}
		this._dValue = Math.round((this._dValue * (this._n - 1) + value) / this._n);
	}

	get value() {
		return this._dValue;
	}
}

class Now {
	/**
	 * Initializes a new instance of the Now class.
	 *
	 * @param {object} adapterInstance - The instance of the ioBroker adapter.
	 */
	constructor(adapterInstance) {
		this.adapter = adapterInstance;
		this._now = new Date();
		this._nowIdx = this._now.getHours();
	}

	renew(referenceTime) {
		this._now = new Date();
		const dt = new Date(referenceTime);
		this._nowIdx = this._now.getHours();
		//nächster Tag
		if (this._now.getDate() != dt.getDate()) this._nowIdx += 24;
	}

	get date() {
		return this._now;
	}

	get idx() {
		return this._nowIdx;
	}
}

export { getAstroDate, adapterAlive, toDateString, isNumber, getStateValue, Average, Now };
