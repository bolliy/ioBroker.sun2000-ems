'use strict';
import * as tools from './tools.mjs';

class Sun2000 {
	/**
	 * The constructor for the Sun2000 class.
	 * @param {object} adapterInstance - The ioBroker adapter instance.
	 */
	constructor(adapterInstance) {
		this.adapter = adapterInstance;
		this.previous = {};
		this.averageConsumption = new tools.Average(10);
		this.averageChargePower = new tools.Average(10);
		this.averageMeterPower = new tools.Average(10);
	}

	async init() {
		this.ratedCapacity = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.ratedCapacity'); //await this.adapter.getState('sun2000.0.inverter.0.battery.ratedCapacity');
		this.maximumChargePower = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.maximumChargePower'); //await this.adapter.getState('sun2000.0.inverter.0.battery.maximumChargePower')?.val;
		await this.getDischargeCutoffCapacity();
		this.chargingCutoffCapacity = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.chargingCutoffCapacity'); //await this.adapter.getState('sun2000.0.inverter.0.battery.chargingCutoffCapacity')?.val;
	}

	pushValue(name, val) {
		if (this.previous[name] === undefined) this.previous[name] = val;
	}

	pullValue(name) {
		const ret = this.previous[name];
		this.previous[name] = undefined;
		return ret;
	}

	//Hausverbrauch
	async getConsumption() {
		return await tools.getStateValue(this.adapter, 'sun2000.0.collected.houseConsumption'); //await this.adapter.getState('sun2000.0.collected.houseConsumption')?.val;
	}

	/**
	 * Get the current State of Charge (SOC) of the battery in percent.
	 * @returns {Promise<number>} The current SOC in percent.
	 */
	async getSOC() {
		return await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.SOC'); //await this.adapter.getState('sun2000.0.inverter.0.battery.SOC')?.val;
	}

	async getDischargeCutoffCapacity() {
		this.dischargeCutoffCapacity = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.dischargeCutoffCapacity'); //await this.adapter.getState('sun2000.0.inverter.0.battery.dischargeCutoffCapacity')?.val;
		return this.dischargeCutoffCapacity;
	}

	async setDischargeCutoffCapacity(value) {
		this.dischargeCutoffCapacity = value;
		return await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.dischargeCutoffCapacity', { val: value });
	}

	async getChargeFromGridFunction() {
		return (await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.chargeFromGridFunction')) === 1; //await this.adapter.getState('sun2000.0.inverter.0.battery.chargeFromGridFunction')?.val) === 1;
	}

	async setChargeFromGridFunction(value) {
		if (value === undefined) {
			const first = this.pullValue('chargeFromGridFunction');
			if (first !== undefined) {
				value = first;
			}
		}
		if (value !== undefined) {
			const chargeFromGrid = await this.getChargeFromGridFunction();
			//Wert merken
			this.pushValue('chargeFromGrid', chargeFromGrid);
			if (value !== chargeFromGrid) {
				await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.chargeFromGridFunction', { val: value, ack: false });
			}
		}
	}

	async getChargeDischargePower() {
		return await tools.getStateValue(this.adapter, 'sun2000.0.collected.chargeDischargePower'); //await this.adapter.getState('sun2000.0.collected.chargeDischargePower')?.val;
	}

	async isBatteryRunning() {
		const status = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.derived.runningStatus'); //await this.adapter.getState('sun2000.0.inverter.0.battery.runningStatus')?.val;
		if (status === 'RUNNING' || status === 'STANDBY') {
			return true;
		}
		return false;
	}

	async wakeUp() {
		this.setChargeFromGridFunction(true);
		if (await this.isBatteryRunning()) {
			return true;
		}
		return false;
	}

	/**
	 * Stops the battery charging process.
	 *
	 * @returns {Promise<boolean>} true if charging was stopped, false otherwise.
	 */
	async stopCharging() {
		try {
			await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.forcibleChargeOrDischarge', { val: 0 });
			await this.setChargeFromGridFunction(undefined);
			return true;
		} catch {
			return false;
		}
	}

	async startcharging(power, duration) {
		const min = Math.round(duration / 60000);
		try {
			//await setState('sun2000.0.inverter.0.control.battery.maximumDischargePower', {val: 0});
			await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.forcibleChargePower', { val: power });
			await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.forcibleChargeOrDischargeSettingMode', { val: 0 });
			await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.forcedChargingAndDischargingPeriod', { val: min });
			await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.forcibleChargeOrDischarge', { val: 1 });
			return true;
		} catch {
			return false;
		}
	}

	async setChargePower(power) {
		try {
			await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.forcibleChargePower', { val: power });
			return true;
		} catch {
			return false;
		}
	}

	async setCharging(unlock) {
		let value;
		try {
			const power = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.maximumChargingPower'); //await this.adapter.getState('sun2000.0.inverter.0.battery.maximumChargingPower')?.val;
			if (unlock) {
				value = this.maximumChargePower;
			} else {
				value = 0;
			}
			if (value !== power) {
				this.adapter.log.debug(`set maximumChargingPower ${value}`);
				await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.maximumChargingPower', { val: value });
			}
			return true;
		} catch {
			return false;
		}
	}

	async getDischargePower() {
		return await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.chargeDischargePower'); //await this.adapter.getState('sun2000.0.inverter.0.battery.chargeDischargePower')?.val;
	}

	//
	async setDisCharging(lock) {
		let value;
		try {
			const power = await tools.getStateValue(this.adapter, 'sun2000.0.inverter.0.battery.maximumDischargingPower'); //await this.adapter.getState('sun2000.0.inverter.0.battery.maximumDischargingPower')?.val;
			if (lock) {
				value = 0;
			} else {
				value = this.maximumChargePower;
			}
			if (value !== power) {
				this.adapter.log.debug(`set maximumDischargingPower ${value}`);
				await this.adapter.setForeignState('sun2000.0.inverter.0.control.battery.maximumDischargingPower', { val: value });
			}
			return true;
		} catch {
			return false;
		}
	}

	async setSurplusBufferSoc(value) {
		try {
			const soc = await tools.getStateValue(this.adapter, 'sun2000.0.control.usableSurplus.bufferSoc');
			if (value !== soc) {
				this.adapter.log.debug(`set bufferSOC to ${value} %`);
				await this.adapter.setForeignState('sun2000.0.control.usableSurplus.bufferSoc', { val: value });
			}
			return true;
		} catch {
			return false;
		}
	}

	async getSurplusMinSoc() {
		const value = await tools.getStateValue(this.adapter, 'sun2000.0.control.usableSurplus.minSoc');
		if (value === undefined) return 20;
		return value;
	}
}

export default Sun2000;
