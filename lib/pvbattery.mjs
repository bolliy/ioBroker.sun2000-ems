//Simulates a battery torage system
class PVBattery {
	/**
	 * The constructor for the PVBattery class.
	 * @param {object} adapterInstance - The ioBroker adapter instance.
	 * @param {object} nowInstance - The Now instance.
	 */
	constructor(adapterInstance, nowInstance) {
		this.adapter = adapterInstance;
		this.now = nowInstance;
		this.batSize = 0;
		this.maxChargePower = 0;
		this.minSoc = 0;
		this.maxSoc = 0;
		this.minLevel = 0;
		this.maxLevel = 0;
		this.chargingLosses = 0;
	}

	/**
	 * Initializes the PVBattery instance with the specified parameters.
	 *
	 * @param {number} batSize - The size of the battery in Wh.
	 * @param {number} [maxChargePower=0] - The maximum charging power in W. Defaults to half of the battery size if not specified.
	 * @param {number} [minSoc=0] - The minimum State of Charge (SOC) percentage.
	 * @param {number} [maxSoc=100] - The maximum State of Charge (SOC) percentage.
	 * @param {number} [chargingLosses=20] - The percentage of energy lost during charging and discharging.
	 */

	async init(batSize, maxChargePower = 0, minSoc = 0, maxSoc = 100, chargingLosses = 20) {
		this.batSize = batSize;
		if (maxChargePower === 0) {
			this.maxChargePower = this.batSize / 2;
		} else {
			this.maxChargePower = maxChargePower;
		}

		this.minSoc = minSoc;
		this.maxSoc = maxSoc;
		this.minLevel = (this.batSize * this.minSoc) / 100;
		this.maxLevel = (this.batSize * this.maxSoc) / 100;
		/*
		 * LiFePO4 - charge- and discharge losses (assuming a round-trip efficency), wich are around 8%  - Lade- und Entladeverluste
		 * DC/AC-Umwandlungsverlusts 5%
		 * 0.95 * 0.92 * 0.95 = 0.83
		 */
		this.chargingLosses = chargingLosses;
	}

	/**
	 * Calculates the battery level, grid usage, and potential overload based on the current energy load and charge.
	 *
	 * @param {number} level - The current energy level of the battery in Wh.
	 * @param {object} loadItem - An object representing the current load with properties such as consumption, pv (PV production),
	 *                            and optionally chargedEnergy, lockCharging, and lockDischarging.
	 * @param {number} [charge=0] - The energy to be charged or discharged in Wh.
	 * @returns {object} An object containing:
	 *   - {number} level: The updated energy level of the battery.
	 *   - {number} grid: The energy drawn from the grid in Wh.
	 *   - {number} overload: The maximum overload in Wh that occurs if charging exceeds battery capacity.
	 */

	_calcLevel(level, loadItem, charge = 0) {
		let grid = 0;
		let overLoad = 0;
		//let lockDischarging = false;
		//charge = -1000;

		if (loadItem.chargedEnergy) {
			charge += loadItem.chargedEnergy;
		}

		let last = loadItem.consumption - loadItem.pv;

		if (charge !== 0) {
			if (charge > this.maxChargePower) {
				overLoad = charge - this.maxChargePower;
				charge = this.maxChargePower;
			}
			//Speicher laden
			if (charge > 0) {
				level += charge * (1 - this.chargingLosses / 200); // half  Ladeverluste
			} else {
				last -= charge;
			}
			grid += charge;
		}
		//Batterie soll zu welchem Stundenanleit nicht entladen werden
		//1 bedeutet die ganze Stunde
		if (loadItem.LockDisCharging > 0 && last > 0) {
			grid += last * loadItem.LockDisCharging;
			last -= last * loadItem.LockDisCharging;
		}

		let rest = level - this.minLevel; //nutzbare Energie im Speicher; Rest um 64Wh Standbyverluste veringern
		if (rest > 0) {
			rest *= 1 - this.chargingLosses / 200; //Entladeverluste
		}

		last += 64; //
		//Speicherentladung
		if (last > rest) {
			grid += last - rest; //Netzbezug
			level = this.minLevel;
		} else {
			level -= last;
		}
		//Speicher Overload
		if (level > this.maxLevel) {
			overLoad += level - this.maxLevel;
			grid = this.maxLevel - level;
			level = this.maxLevel;
			//console.log('level ' +level+' grid '+grid+' last '+last+' overload '+overLoad);
		}
		grid = Math.round(grid);
		level = Math.round(level);
		return { level: level, grid: grid, overload: overLoad };
	} //of PVBattery

	/**
	 * Simulates the charging process based on the provided load table and energy consumption to determine possible overload scenarios.
	 *
	 * @param {object[]} load - The load table as an array of objects with idx, consumption, pv, balance, lockCharging, lockDischarging, and time properties.
	 * @param {number} idx - The index of the hour to start the simulation from.
	 * @param {number} energy - The energy to be charged in Wh.
	 * @param {number} soc - The State of Charge (SOC) of the battery in percent.
	 * @returns {number} The maximum overload in Wh that can occur during the simulation.
	 */
	simulateCharge(load, idx, energy, soc) {
		let level = (this.batSize * soc) / 100;
		let overLoad = 0;

		for (let i = this.now.idx; i < load.length; i++) {
			let aktEnergy = 0;
			if (i === idx) aktEnergy += energy;
			const ret = this._calcLevel(level, load[i], aktEnergy);

			level = ret.level;
			//Kommt es danach zur Überladung
			if (i >= idx && ret.overload > overLoad) {
				overLoad = ret.overload;
			}
		}
		return overLoad;
	}

	/**
	 * Returns a table of battery state of charge (SOC) values for the given load table
	 * and specified end index. The table is calculated based on the current energy level
	 * of the battery and the energy consumption pattern from the load table.
	 *
	 * @param {object[]} load - The load table as an array of objects with idx, consumption, pv, balance, lockCharging, lockDischarging, and time properties.
	 * @param {number} toIdx - The index of the last hour to calculate the SOC for.
	 * @param {number} soc - The State of Charge (SOC) of the battery in percent.
	 * @param {boolean} alowNegative - Indicates if negative SOC values are allowed.
	 * @returns {object[]} An array of objects with idx, price, soc, level, grid, pv, consumption, lockDischarging, and lockCharging properties.
	 */
	getSOCTable(load, toIdx, soc, alowNegative = false) {
		const socTbl = [];
		let level = (this.batSize * soc) / 100;

		//console.log('Level '+level);
		for (let i = 0; i < this.now.idx; i++) {
			socTbl.push({ idx: load[i].idx, soc: 0 });
		}
		//ab dieser Stunde berechnen ...
		for (let i = this.now.idx; i < toIdx; i++) {
			const loadItem = { ...load[i] }; // Object copy --> Spread Method
			if (i === this.now.idx) {
				const factor = (this.now.minutesOfUnit - this.now.date.getMinutes()) / this.now.minutesOfUnit;
				loadItem.pv = Math.round(loadItem.pv * factor);
				loadItem.consumption = Math.round(loadItem.consumption * factor);
			}
			const ret = this._calcLevel(level, loadItem);
			level = ret.level;
			if (alowNegative && ret.grid > 0) {
				level -= ret.grid;
				ret.grid = 0;
			}

			soc = Math.round((level * 100) / this.batSize);
			socTbl.push({
				idx: loadItem.idx,
				//price: 0,
				level: level,
				soc: soc,
				grid: ret.grid,
				pv: loadItem.pv,
				consumption: loadItem.consumption,
				time: loadItem.time,
			});
		}
		return socTbl;
	}
}

export default PVBattery;
