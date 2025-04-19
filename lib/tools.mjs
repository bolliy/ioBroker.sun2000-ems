'use strict';

/**
 * Checks if the given adapter is alive.
 *
 * @param {ioBroker.Adapter} adapter an instance of the ioBroker Adapter
 * @param {string} adapterName the name of the adapter
 * @param {number} intanceNumber the instance number of the adapter
 * @returns {Promise<object>} an object with the following properties:
 * - exist: a boolean indicating if the adapter is installed and configured
 * - alive: a boolean indicating if the adapter is currently running
 */
async function adapterAlive(adapter, adapterName, intanceNumber) {
	const state = await adapter.getForeignStateAsync(`system.adapter.${adapterName}.${intanceNumber.toString()}.alive`);
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

export { adapterAlive, toDateString, isNumber };
