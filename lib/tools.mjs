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
	//const obj = await adapter.getObjectAsync(`system.adapter${adapterName}.${intanceNumber.toString()}`);
	const obj = await adapter.getObjectAsync(`system.adapter.admin.0`);
	adapter.log.debug(`system.adapter.sun2000-ems.${intanceNumber.toString()} ${JSON.stringify(obj)}`);
	if (!obj) {
		return false;
	}
	const state = await adapter.getStateAsync(`system.adapter.${adapterName}.${intanceNumber.toString()}.alive`);
	if (state) {
		return state.val === true;
	}

	return false;
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

export { adapterAlive, toDateString };
