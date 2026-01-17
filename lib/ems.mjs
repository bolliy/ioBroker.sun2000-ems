import LoadTable from './loadtable.mjs';
import Tibber from './tibber.mjs';
import Sun2000 from './sun2000.mjs';
import PVBattery from './pvbattery.mjs';
import * as tools from './tools.mjs';
import cron from 'node-cron';

class EMS {
	constructor(adapterIntance) {
		this.adapter = adapterIntance;
		this.now = new tools.Now(this.adapter); //base of time

		this.iBattery = new PVBattery(this.adapter, this.now);

		this.iPrices = new Tibber(this.adapter);

		this.iLoad = new LoadTable(this.adapter);
		this.inverter = new Sun2000(this.adapter);
		this.averageConsumption = new tools.Average(2);
		this.averageChargePower = new tools.Average(2);
		this.averagMeterPower = new tools.Average(10);
		this.process = {};
		this.load = []; //Load table
		this.tbl = []; //SOC table
		this.lock = []; //Charge and DisCharge Lock table
		this.newChargingPoints = [];
		//this.chargingPoints = [];
		this.SOC = 0;

		this.debug = 1; //0=normal, 1=Test Tibber, 2=stop after optimizeCharging
	}

	async init() {
		await this.iPrices.init(await tools.getStateValue(this.adapter, '0_userdata.0.tibber.homeId'));
		await this.inverter.init();
		await this.iBattery.init(
			this.inverter.ratedCapacity,
			this.inverter.maximumChargePower,
			this.inverter.dischargeCutoffCapacity,
			this.inverter.chargingCutoffCapacity,
			20,
		);
	}

	/**
	 * Calculates the surplus and feed-in energy for the current day starting from a specified index.
	 * The function evaluates the energy surplus and feed-in based on the PV production and consumption data.
	 *
	 * @param {number} startIdx - The starting index from which to calculate the surplus and feed-in.
	 * @returns {object} An object containing:
	 *   - {number} idx - The starting index for the calculation.
	 *   - {number} surplus - The total surplus energy in Wh from PV production minus consumption.
	 *   - {number} feedIn - The total energy fed into the grid in Wh.
	 */
	_getSurplusToday(startIdx) {
		let toIdx = 23;
		if (this.now.idx > 23) toIdx = 47;
		let surplus = 0;
		let feedIn = 0;
		for (let i = startIdx; i <= toIdx; i++) {
			//this.adapter.log.debug(`_getSurplusToday idx ${i} pv ${this.load[i].pv} consumption ${this.load[i].consumption} grid ${this.tbl[i].grid}`);
			let factor = 1;
			if (i === this.now.idx) {
				factor = (this.now.minutesOfUnit - this.now.date.getMinutes()) / this.now.minutesOfUnit;
			}
			//Überschuss Energy
			if (this.load[i].pv - this.load[i].consumption > 0) {
				surplus += (this.load[i].pv - this.load[i].consumption) * factor;
			}
			//feed in
			if (this.tbl[i]?.grid < 0) {
				feedIn -= this.tbl[i].grid * factor;
			}
		}
		surplus = Math.round(surplus);
		feedIn = Math.round(feedIn);
		return { idx: startIdx, surplus: surplus, feedIn: feedIn };
	}

	_lockDisCharging2(highRange) {
		const locks = [];
		const prices = this.iPrices.jsonData; //aktuelle Preise holen
		let sum = 0;
		let total = 0;
		//summe der Energy
		for (let k = 0; k < highRange.length; k++) {
			total += highRange[k].energy;
		}
		for (let k = 0; k < highRange.length; k++) {
			const relLP = []; //relevante Ladepunkte
			for (let i = this.now.idx2 + 1; i < highRange[k].start; i++) {
				//günstiger als Preisschwelle
				if (prices[i].total < highRange[k].threshold) {
					relLP.push({ idx: i, price: prices[i].total });
				}
			}
			//relevante Punkte nach Einstandspreis aufsteigend sortieren
			relLP.sort(function (a, b) {
				return a.price - b.price;
			});

			let rest = highRange[k].energy; //welche Energy soll nach vorn verlagert werden
			for (let i = 0; i < relLP.length; i++) {
				/*
				// dischargeCutoffCapacity check
				const tbl = this.iBattery.getSOCTable(this.load, (highRange[k].start / 4) >> 0, this.SOC, true);
				const exist = tbl.findIndex(x => x.soc <= this.inverter.dischargeCutoffCapacity && x.idx >= this.now.idx);
				// Battery does not go below dischargeCutoffCapacity
				if (exist === -1) break;
				*/
				const hh = (relLP[i].idx / 4) >> 0; // at which hour
				if (!this.load[hh].LockDisCharging || this.load[hh].LockDisCharging <= 0.75) {
					const dischargedEnergy = Math.round((this.load[hh].consumption - this.load[hh].pv) / 4);
					if (dischargedEnergy > 0 && dischargedEnergy <= rest) {
						const exist = locks.findIndex(x => x.idx === relLP[i].idx);
						if (exist === -1) {
							if (!this.load[hh].LockDisCharging) this.load[hh].LockDisCharging = 0;
							this.load[hh].LockDisCharging += 0.25; // + 1/4 hour
							locks.push({
								idx: relLP[i].idx,
								idx_hh: hh,
								price: relLP[i].price,
								discharge: dischargedEnergy,
								time: prices[relLP[i].idx].startsAt,
							});
							rest -= dischargedEnergy;
							sum += dischargedEnergy;
						}
					}
				}
				if (rest <= 0) break;
			}
			if (total - sum <= 0) break;
		}
		//aufsteigend sortieren
		locks.sort(function (a, b) {
			return a.idx - b.idx;
		});

		this.adapter.log.debug(`_lockDisCharging2 ${sum}W of ${total}W locks: ${JSON.stringify(locks)}`);
		return { sum: sum, locks: locks }; //return locks;
	}

	_lockDisCharging(highRange) {
		const lock = [];
		const prices = this.iPrices.jsonData; // get current prices
		const sum = { energy: 0, threshold: 0, min: Infinity, max: 0, start: Infinity, end: 0 };

		for (let k = 0; k < highRange.length; k++) {
			sum.energy += highRange[k].energy;
			//sum.min = Math.min(sum.min, highRange[k].threshold);
			//sum.max = Math.max(sum.max, highRange[k].threshold);
			sum.start = Math.min(sum.start, highRange[k].start); // earliest start point
			sum.end = Math.max(sum.end, highRange[k].start); // latest start point
			sum.threshold = Math.min(sum.threshold, highRange[k].price); // lowest price
		}

		// Calculate threshold
		/*
		if (sum.min !== Infinity) {
			sum.threshold = (sum.min + sum.max) / 2;
		}
		*/

		// Sort prices
		const sort = [];
		// start at least in the next quarter hour
		for (let i = this.now.idx2 + 1; i < sum.start; i++) {
			if (i >= prices.length) break;
			if (prices[i]?.total < sum.threshold) {
				sort.push(prices[i]);
			}
		}

		// Sort relevant lock points by price
		sort.sort((a, b) => a.total - b.total);

		let gridSum = 0;
		for (let i = 0; i < sort.length; i++) {
			const tbl = this.iBattery.getSOCTable(this.load, (sum.end / 4) >> 0, this.SOC, true);
			const exist = tbl.findIndex(x => x.soc <= this.inverter.dischargeCutoffCapacity && x.idx >= this.now.idx);
			// Battery does not go below dischargeCutoffCapacity
			if (exist === -1) break;

			const hh = (sort[i].idx / 4) >> 0; // at which hour
			if (!this.load[hh].LockDisCharging || this.load[hh].LockDisCharging <= 0.75) {
				const dischargedEnergy = Math.round((this.load[hh].consumption - this.load[hh].pv) / 4);
				const exist = lock.findIndex(x => x.idx === sort[i].idx);
				if (exist === -1) {
					if (!this.load[hh].LockDisCharging) this.load[hh].LockDisCharging = 0;
					this.load[hh].LockDisCharging += 0.25; // + 1/4 hour
					gridSum += dischargedEnergy;
					lock.push({ idx: sort[i].idx, idx_hh: hh, price: sort[i].total, discharge: dischargedEnergy, time: sort[i].startsAt });
				}
			}
		}

		lock.sort(function (a, b) {
			return a.idx - b.idx;
		});

		this.adapter.log.debug(`_lockDisCharging ${gridSum}W of ${sum.energy}W ${JSON.stringify(lock)}`);
		return { sum: gridSum, locks: lock }; //return lock;
	}

	//Suche hohe Dynamische Preise
	//Tibber
	_searchHighPrices(soc, chargingLossFactor = 1) {
		//kann aus this.prices entnommen werden
		const prices = this.iPrices.jsonData;
		const toIdx = (prices.length / 4) >> 0;
		const tbl = this.iBattery.getSOCTable(this.load, toIdx, soc);

		const ret = [];

		let smallestPrice = Infinity;
		let threshold = 0;
		let sum = 0;

		if (chargingLossFactor === 0) {
			let sumPrice = 0;
			let anz = 0;
			let avr = 0;
			for (let k = this.now.idx2 + 1; k < prices.length; k++) {
				sumPrice += prices[k].total;
				anz++;
				avr = sumPrice / anz; // average price
				threshold = Math.round(avr * 1000) / 1000; //Preisschwelle für dischargeLocking
			}
		}

		//Ermittlung der zu verlagernde Energie
		for (let k = this.now.idx2 + 1; k < prices.length; k++) {
			smallestPrice = Math.min(smallestPrice, prices[k].total); // lowest price
			//Preisschwelle
			//durch Ladeverluste erhöht sich die untere Preisgrenze
			const priceFactor = 1 + (this.iBattery.chargingLosses / 100) * chargingLossFactor; //+17% mehr Energie laden
			if (chargingLossFactor !== 0) {
				threshold = Math.round(smallestPrice * priceFactor * 1000) / 1000; //Preisschwelle
			}
			const hh = (k / 4) >> 0; //zu welcher Stunde
			if (tbl[hh].grid > 0 && prices[k].total > threshold) {
				//Preisgrenze für das Laden von Energie
				if (chargingLossFactor !== 0) {
					threshold = Math.round((prices[k].total / priceFactor) * 1000) / 1000;
				}
				const chargingEnergy = Math.round((tbl[hh].grid / 4) * priceFactor);
				sum += chargingEnergy;
				ret.push({
					threshold: threshold,
					price: prices[k].total,
					total: Math.round(chargingEnergy * prices[k].total),
					energy: chargingEnergy,
					start: k,
					time: prices[k].startsAt,
				});
			}
		}

		//Sortiert teuer zu günstig!
		ret.sort(function (a, b) {
			return b.price - a.price;
		});

		this.adapter.log.debug(`EMS._searchHighPrices ${sum}W ${JSON.stringify(ret)}`);
		//Rückgabe der zu verlagernden Energie
		return { sum: sum, highRanges: ret };
	}
	//Tibber
	_putInLowZone(highRange, soc) {
		const loadPoint = [];
		const prices = this.iPrices.jsonData; //aktuelle Preise holen
		let sumRest = 0;
		//relevante Ladepunkte suchen, die günstiger als die Preisgrenze sind
		for (let k = 0; k < highRange.length; k++) {
			const relLP = []; //relevante Ladepunkte
			for (let i = this.now.idx2 + 1; i < highRange[k].start; i++) {
				//günstiger als die untere Preisschwelle
				if (prices[i].total < highRange[k].threshold) {
					relLP.push({ idx: i, price: prices[i].total });
				}
			}
			//relevante Ladepunkte nach Einstandspreis aufsteigend sortieren
			relLP.sort(function (a, b) {
				return a.price - b.price;
			});

			let rest = highRange[k].energy; //welche Energy soll nach vorn verlagert werden
			//rest += (highRange[k].start - this.nowIdx)*64; //64 W Stanby-By Verluste
			//console.log('Rest '+rest);

			for (let i = 0; i < relLP.length; i++) {
				let energy = rest;
				const maxPower = this.inverter.maximumChargePower * 0.8; //80% der maximalen Leistung - schont die Batterie
				if (energy > maxPower / 4) energy = maxPower / 4; //1250 Wh
				const hh = (relLP[i].idx / 4) >> 0; //zu welcher Stunde
				//simuliere das Charging from grid
				const overLoad = this.iBattery.simulateCharge(this.load, hh, energy, soc);
				if (overLoad > 0) energy -= overLoad;
				if (energy > 0) {
					//search the next unfull charged point
					const exist = loadPoint.findIndex(x => x.idx === relLP[i].idx);
					if (exist > -1) {
						if (loadPoint[exist].power / 4 + energy > maxPower / 4) {
							energy = maxPower / 4 - loadPoint[exist].power / 4;
							if (energy < 0) energy = 0;
						}
					}
					if (energy > 0) {
						energy = Math.round(energy);
						if (exist > -1) {
							loadPoint[exist].power += energy * 4; //Charge power
							loadPoint[exist].energy += energy;
							//kleinster verlagerter high price Punkt
							if (highRange[k].start < loadPoint[exist].start) loadPoint[exist].start = highRange[k].start;
						} else {
							loadPoint.push({
								idx: relLP[i].idx,
								time: prices[relLP[i].idx].startsAt,
								energy: energy,
								power: energy * 4,
								price: relLP[i].price,
								start: highRange[k].start,
							});
						}

						if (this.load[hh].chargedEnergy > 0) {
							this.load[hh].chargedEnergy += energy;
						} else {
							this.load[hh].chargedEnergy = energy;
						}
					}
				}

				if (energy > 0) rest -= energy;
				if (rest <= 0) break;
			}
			sumRest += rest;
		}

		//kleine Loads entfernen
		for (let i = 0; i < loadPoint.length; i++) {
			if (loadPoint[i].power < 100) {
				const hh = (loadPoint[i].idx / 4) >> 0;
				this.load[hh].chargedEnergy -= loadPoint[i].energy;
				if (this.load[hh].chargedEnergy < 0) this.load[hh].chargedEnergy = 0;
				loadPoint.splice(i, 1);
				i -= 1;
			}
		}
		loadPoint.sort(function (a, b) {
			return a.idx - b.idx;
		});

		let sum = 0;
		loadPoint.forEach(element => {
			sum += element.energy;
		});
		this.adapter.log.debug(`LoadPoint Sum ${sum} Wh Rest ${sumRest} Wh ${JSON.stringify(loadPoint)}`);
		return { sum: sum, rest: sumRest, loadPoints: loadPoint }; //sum, sumRest, loadPoints;
	}

	/**
	 * Calculates the forecast-based charging plan for the current day.
	 * Tries to charge the battery if there is a surplus of energy
	 * from the PV forecast and the current SOC is above 30%.
	 *
	 * Der Methodenname sollte geändert werden!
	 * gridFriendlyFeed-in
	 *
	 */
	_gridFriendlyFeedIn() {
		this.inverter.getSurplusBufferSoc().then(thresholdSoc => {
			//Ermittlung des Überschusses ab jetzt
			let startIdx = 12;
			if (this.now.idx > 12) startIdx = this.now.idx;
			const surplus = this._getSurplusToday(startIdx);
			if (this.debug == 2) {
				this.adapter.log.debug(`Surplus Today: ${JSON.stringify(surplus)}`);
			}
			let surplusRest = surplus.feedIn * 0.75; //Ausfallwagnis

			if (surplusRest >= 2000) {
				for (let i = this.now.idx; i < 12; i++) {
					if (this.load[i].pv > 0 && !this.load[i].chargedEnergy && this.tbl[i]?.soc > thresholdSoc) {
						let surplus = this.load[i].pv - this.load[i].consumption;
						if (surplus < 0) surplus = 0;
						if (surplus < surplusRest) {
							this.load[i].chargedEnergy = -surplus;
							this.load[i].lockCharging = true;
							surplusRest += this.load[i].chargedEnergy;
							if (this.debug == 2) {
								this.adapter.log.debug(`tbl grid ${this.tbl[i].idx} soc ${this.tbl[i].soc}`);
							}
						} else {
							continue;
						}
					}
					if (surplusRest < 1000) continue;
				}
			}
			//load soc table
			this.tbl = this.iBattery.getSOCTable(this.load, this.load.length, this.SOC);
		});
	}

	/**
	 * @description
	 * This function is called every minute and looks at the current SOC and the SOC
	 * forecast for the next hour. If the SOC is greater than or equal to the forecast
	 * SOC, charging is enabled. If the SOC is lower than the forecast SOC, charging is
	 * disabled. If the lockCharging flag is not set, charging is disabled.
	 */
	async forcastBasedCharging() {
		//Simulation:
		//Justiert den zu simulierenden Soc-Verlauf (SocTable) so weit nach unten, dass dischargeCutoffCapacity nicht unterschritten wird.
		let simSoc = this.inverter.dischargeCutoffCapacity; //mindestens auf Entladegrenze setzen
		//Soc-Table mit negativen SOC Werten simulieren
		let tbl = this.iBattery.getSOCTable(this.load, this.load.length, this.SOC, true);
		//this.adapter.log.debug(`forcastBasedCharging tbl with allowNegative SOV Values ${JSON.stringify(tbl)}`);
		//Ermittlung des kleinsten SOC ab jetzt
		let smallestSoc = 100; //starten bei 100%
		for (let i = this.now.idx; i < this.load.length; i++) {
			if (tbl[i].soc < smallestSoc) smallestSoc = tbl[i].soc;
		}
		//Ermittlung den SOC Überschuss
		const overSoc = Math.round(smallestSoc - this.inverter.dischargeCutoffCapacity);
		if (this.SOC - overSoc > simSoc) simSoc = this.SOC - overSoc;
		if (simSoc > this.inverter.chargingCutoffCapacity) simSoc = this.inverter.chargingCutoffCapacity;
		//this.adapter.log.debug(`forcastBasedCharging overSOC ${overSoc} simSoc ${simSoc}`);
		//Simulierte die SocTable mit simSoc
		tbl = this.iBattery.getSOCTable(this.load, this.load.length, simSoc, true);
		//Ermittlung surplusBufferSOC aus der Simulation
		//Alles was über den simulierten maximalen SOC hinausgeht, kann verbraucht werden
		let surplusBufferSOC = 0; //PufferSOC ermitteln
		for (let i = this.now.idx; i < this.load.length; i++) {
			if (tbl[i].soc > surplusBufferSOC) surplusBufferSOC = tbl[i].soc;
		}
		//Der suplusMinSoc wird auf die Hälfte zwischen simSoc und surplusBufferSOC gesetzt
		//let suplusMinSoc = (surplusBufferSOC - simSoc) / 2 + simSoc;
		let suplusMinSoc = simSoc + 1;
		if (suplusMinSoc > this.inverter.chargingCutoffCapacity) suplusMinSoc = this.inverter.chargingCutoffCapacity - 1;
		if (suplusMinSoc < this.inverter.dischargeCutoffCapacity) suplusMinSoc = this.inverter.dischargeCutoffCapacity;
		await this.inverter.setSurplusMinSoc(suplusMinSoc);
		if (surplusBufferSOC < suplusMinSoc) surplusBufferSOC = 100;
		await this.inverter.setSurplusBufferSoc(surplusBufferSOC);
		if (this.debug === 2) {
			this.adapter.log.debug(`forcastBasedCharging overSOC ${overSoc}`);
			this.adapter.log.debug(`forcastBasedCharging simSoc ${simSoc}`);
			this.adapter.log.debug(`forcastBasedCharging tbl - allowNegative  ${JSON.stringify(tbl)}`);
			this.adapter.log.debug(`forcastBasedCharging ${JSON.stringify(this._getSurplusToday(this.now.idx))}`);
		}
		this.adapter.log.debug(`forcastBasedCharging overSOC ${overSoc} simSoc ${simSoc} suplusMinSoc ${suplusMinSoc} surplusBufferSOC ${surplusBufferSOC}`);

		//verspätes Laden über 85% SOC
		//muss noch überarbeitet werden!
		if (this.load[this.now.idx]?.lockCharging) {
			await this.inverter.setCharging(this.SOC < simSoc);
		} else {
			let charge = true;
			//möglichst den Speicher nur Laden bis 85%
			//bufferSOC < 85 &&
			if (this.SOC >= 85 && this.SOC < this.inverter.chargingCutoffCapacity) {
				const energyToFull = ((this.inverter.chargingCutoffCapacity - this.SOC) * this.inverter.ratedCapacity) / 100;
				const surplus = this._getSurplusToday(this.now.idx)?.surplus ?? 0;
				if (energyToFull < surplus * 0.75) charge = false; //??
				this.adapter.log.debug(`processForcastBasedCharging energyToFull ${energyToFull} < surplus ${surplus} allow Battery charging ${charge}`);
			}
			await this.inverter.setCharging(charge);
		}
	}

	async optimizeCharging() {
		this.SOC = await this.inverter.getSOC();

		//this.SOC = 10; //Test !!

		await this.iPrices.update(); //Tibberpreise holen
		this.prices = this.iPrices.jsonData;
		//Ladetabelle holen
		await this.iLoad.update(); //LastProfile aus PVForcast erstellen
		this.now.renew(this.iLoad.jsonData[0].time); //Bezugsdatum verwenden
		this.load = this.iLoad.jsonData; //Last Tabelle holen
		this.tbl = this.iBattery.getSOCTable(this.load, this.load.length, this.SOC); //Soc Tabelle

		let highPrices = this._searchHighPrices(this.SOC, 0); //ohne Ladeverluste
		const locks = this._lockDisCharging2(highPrices.highRanges);
		this.lock = locks.locks;

		highPrices = this._searchHighPrices(this.SOC); //mit Ladeverlusten
		const ret = this._putInLowZone(highPrices.highRanges, this.SOC);
		this.newChargingPoints = ret.loadPoints; //Ladepunkte

		this.tbl = this.iBattery.getSOCTable(this.load, this.load.length, this.SOC);
		//Tibber ++

		//Grid Friendly Feed-In
		this._gridFriendlyFeedIn(); //im Sommer: Energie zeitversetzt Einspeisen

		//this.tbl = this.iBattery.getSOCTable(this.load, this.load.length /*this.iPrices.jsonData.length*/, this.SOC);

		if (this.debug > 0) {
			this.adapter.log.debug(`Load table ${JSON.stringify(this.load)}`);
			this.adapter.log.debug(`soc tbl ${JSON.stringify(this.tbl)}`);
			this.adapter.log.debug(`#### OptimizeCharging Ende ####`);
		}
	}

	adjustPower(soc, duration) {
		const restEnergy = ((this.process.task.chargePoint.soc - soc) * this.inverter.ratedCapacity) / 100;
		let power = (restEnergy / duration) * 60000 * 60 * (1 + this.iBattery.chargingLosses / 200); //+10%
		if (power > this.inverter.maximumChargePower) power = this.inverter.maximumChargePower;
		if (power < 0) power = 0;
		power = Math.round(power);
		this.adapter.log.debug(`Adjust Power ${power}`);
		return power;
	}

	async controlCharging2() {
		const duration = this.process?.task.end.getTime() - this.now.date.getTime();
		const power = this.process?.task.chargePoint.power;
		const state = await this.adapter.getForeignStateAsync('sun2000.0.inverter.0.control.battery.forcibleChargeOrDischarge');
		const isStarted = state && state?.val === 1 && state?.ts >= this.process.task.start.getTime();
		//const isCharge = await this.inverter.isChargingFromGrid(); //?? Problem
		if (!isStarted) {
			this.adapter.log.info('Start Battery charging from grid...');
			await this.inverter.startcharging(power, duration);
			this.process.lastPower = power;
		} else {
			if (!this.process.lastPower || Math.abs(this.process.lastPower - power) >= 100) {
				await this.inverter.setChargePower(power);
				this.process.lastPower = power;
			}
		}
	}

	async processeing2() {
		const task = {}; //aktive task clear
		/*
		{"idx":14,"time":"2025-10-24 14:00:00","charge":2314,"price":0.1973,"start":42,"soc":30}
		
		this.newChargingPoints = [];
		if (this.newChargingPoints.length === 0) {
			this.newChargingPoints.push({
				time: '2025-11-14 16:30:00',
				charge: 100,
			});
			this.newChargingPoints.push({
				time: '2025-11-08 16:45:00',
				charge: 100,
			});
		}
		*/

		//aktuellen ChargePoint rückwärts suchen
		for (let i = this.newChargingPoints.length - 1; i >= 0; i--) {
			//for (let i = 0; i < this.newChargingPoints.length; i++) {
			const start = new Date(this.newChargingPoints[i].time);
			const wakeUp = new Date(this.newChargingPoints[i].time);
			wakeUp.setMinutes(wakeUp.getMinutes() - 45); //Startzeit für WakeUp
			const end = new Date(this.newChargingPoints[i].time);
			end.setMinutes(end.getMinutes() + 15); //Endzeit
			if (this.now.date >= wakeUp && this.now.date < end) {
				task.chargePoint = this.newChargingPoints[i];
				task.start = new Date(start);
				task.wakeUp = new Date(wakeUp);
				task.end = new Date(end);
				this.process.task = task; //Task einhängen
			}
		}

		if (Object.keys(task).length !== 0) {
			this.adapter.log.debug(`aktueller ChargeTask ${JSON.stringify(task)} ###`);
			//Batterie muss Online sein
			if (await this.inverter.wakeUp()) {
				//this.adapter.log.debug('Battery was waken up');
				if (this.now.date >= task.start && this.now.date < task.end) {
					await this.controlCharging2();
				}
			} else {
				this.adapter.log.debug('Waiting for Battery woke up ...');
			}
		} else {
			if (Object.keys(this.process).length !== 0) {
				if (await this.inverter.stopCharging()) {
					this.adapter.log.info('Battery charging stopped');
					this.process = {};
				}
			}
		}
	}

	async updateAverages() {
		await this.inverter.getDischargeCutoffCapacity();
		this.SOC = await this.inverter.getSOC();
		this.averageChargePower.newValue = (await this.inverter.getChargeDischargePower()) * 1000; //Watt
		this.averageConsumption.newValue = (await this.inverter.getConsumption()) * 1000; //Watt
		this.averagMeterPower.newValue = (await tools.getStateValue(this.adapter, 'sun2000.0.meter.activePower')) * 1000; //await this.adapter.getState('sun2000.0.meter.activePower')?.val) * 1000;
	}

	//Speicher auf 20% setzen
	async reduceBatteryLosses() {
		const h = this.now.date.getHours();

		//Nach 22:00 Uhr
		if (h >= 22) {
			if (this.averageConsumption.value < 150) {
				if (this.inverter.dischargeCutoffCapacity < 20 && this.inverter.dischargeCutoffCapacity < this.SOC) {
					if (await this.inverter.isBatteryRunning()) {
						let newVal = this.SOC;
						if (newVal > 20) {
							newVal = 20;
						}
						console.info(`Set dischargeCutoffCapacity to ${newVal}%`);
						await this.inverter.setDischargeCutoffCapacity(newVal);
						//await this.inverter.setChargeFromGridFunction(false);
					}
				}
			}
		} else {
			if (this.averageConsumption.value > 200 && h >= 4) {
				if (this.inverter.dischargeCutoffCapacity > 5) {
					if (await this.inverter.wakeUp()) {
						console.info('Set dischargeCutoffCapacity to 5%');
						await this.inverter.setDischargeCutoffCapacity(5);
					}
				}
			}
		}
	}

	/**
	 * A function that determines whether to charge from the grid based on certain conditions.
	 *
	 * @returns {Promise<void>} Resolves once the decision to charge from the grid is made.
	 */
	async chargeFromGrid() {
		//Wird Energie eingespeist
		//Das Einschlafen des WR/Luna ermöglichen
		let chargeGrid = -1;
		//Nachts
		if (this.now.date < this.sunset || this.now.date > this.sunrise) {
			if (this.SOC <= this.inverter.dischargeCutoffCapacity) {
				chargeGrid = 0;
			}
		}
		//Energie z.B. vom Balkonkraftwerk
		if (this.averagMeterPower.value > 100 && this.SOC < this.inverter.chargingCutoffCapacity) {
			chargeGrid = 1;
		}
		if (chargeGrid > -1) {
			await this.inverter.setChargeFromGridFunction(chargeGrid === 1);
		}
	}

	/**
	 * Check if the battery load is high based on average charge power and consumption.
	 *
	 * @returns true if the battery load is high, false otherwise
	 */
	async isHighBatteryLoad() {
		//console.log('Speicherladung: averageChargePower '+this.averageChargePower.value+' , averageConsumption '+this.averageConsumption.value);
		if (this.averageConsumption.value > this.inverter.maximumChargePower * 0.8) {
			this.adapter.log.debug(`Hohe Speicherentladung --> Sperrung : ${this.averageChargePower.value}`);
			return true;
		}
		return false;
	}

	async processLock() {
		//high battery load -> discharging locken
		if (await this.isHighBatteryLoad()) {
			await this.inverter.setLockDisCharging(true);
		} else {
			if (this.SOC > this.inverter.dischargeCutoffCapacity) {
				const exist = this.lock.findIndex(x => x.idx === this.now.idx2);
				await this.inverter.setLockDisCharging(exist > -1);
			} else {
				await this.inverter.setLockDisCharging(false);
			}
		}
	}

	async dataPolling() {
		await this.init();
		await tools.getSystemData(this.adapter);
		await this.atMidnight();
		await this.optimizeCharging(); //for Tibber

		if (this.debug === 2) {
			this.adapter.log.debug(`debug ${this.debug} - stop processing`);
			return;
		}

		await this.forcastBasedCharging();
		this.scheduleHandle = cron.schedule('29,59 * * * *', async () => {
			this.now.renew(this.iLoad.jsonData[0].time);
			await this.optimizeCharging();
		});
		// every Minute
		this.scheduleHandle2 = cron.schedule('* * * * *', async () => {
			this.now.renew(this.iLoad.jsonData[0].time);
			await this.updateAverages();
			await this.processLock();
		});
		// every 5 minutes
		this.scheduleHandle3 = cron.schedule('*/5 * * * *', async () => {
			this.now.renew(this.iLoad.jsonData[0].time);
			await this.processeing2();
			await this.forcastBasedCharging();
			if (Object.keys(this.process).length !== 0) return;
			await this.chargeFromGrid();
		});

		//console.log('test '+JSON.stringify(this.iBattery._calcLevel(5000)))
	}

	async atMidnight() {
		this.sunrise = tools.getAstroDate(this.adapter, 'sunrise');
		this.sunset = tools.getAstroDate(this.adapter, 'sunset');

		const now = new Date();
		const night = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + 1, // the next day, ...
			0,
			0,
			0, // ...at 00:00:00 hours
		);
		const msToMidnight = night.getTime() - now.getTime();

		if (this.mitnightTimer) {
			this.adapter.clearTimeout(this.mitnightTimer);
		}
		this.mitnightTimer = this.adapter.setTimeout(async () => {
			//await this.state.mitnightProcess(); //      the function being called at midnight.
			this.atMidnight(); //      reset again next midnight.
		}, msToMidnight);
	}

	destroy() {
		this.adapter.log.info('EMS destroyed');
		this.mitnightTimer && this.adapter.clearTimeout(this.mitnightTimer);
		this.scheduleHandle && this.scheduleHandle.stop();
		this.scheduleHandle2 && this.scheduleHandle2.stop();
		this.scheduleHandle3 && this.scheduleHandle3.stop();
	}
} //End of CLASS EMS

export default EMS;
