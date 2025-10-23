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
		this.newChargingPoints = [];
		this.chargingPoints = [];
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
			17,
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

	/*
	/ Tibber
    / Das Entladen des Speichers bei geringen Preisen verhindern
    */
	_lockDisCharging(load, highRange) {
		const prices = this.iPrices.jsonData; //aktuelle Preise holen
		//relevante Ladepunkte suchen, die günstiger als die Preisgrenze sind
		const sum = { threshold: 0, energy: 0, start: 0 }; //relevanten Ladepunkte

		for (let k = 0; k < highRange.length; k++) {
			sum.threshold = highRange[k].threshold;
			sum.energy += highRange[k].energy;
			if (highRange[k].start > sum.start) sum.start = highRange[k].start;
		}

		const sort = [];
		for (let i = this.now.idx; i < sum.start; i++) {
			if (prices[i].total < sum.threshold) {
				sort.push(prices[i]);
			}
		}
		sort.sort(function (a, b) {
			return a.total - b.total;
		});

		//this.adapter.log.info('LockDischarge '+JSON.stringify(sort));

		let grid = 0;
		for (let i = 0; i < sort.length; i++) {
			let last = load[sort[i].idx].consumption - load[sort[i].idx].pv;
			//console.log('idx '+sort[i].idx+' last '+last+' pv '+load[sort[i].idx].pv);
			if (!load[sort[i].idx].lockDischarging && last > 0) {
				load[sort[i].idx].lockDischarging = true;
				grid += last;
			}
			if (grid >= sum.energy) break;
		}

		//console.log('getLoadPoints '+JSON.stringify(sum));
	}

	//Suche hohe Dynamische Preise
	//Tibber
	_searchHighPrices(soc) {
		//kann aus this.prices entnommen werden
		const prices = this.iPrices.jsonData;
		const toIdx = prices.length;
		const tbl = this.iBattery.getSOCTable(this.load, toIdx, soc);

		const ret = [];

		let smallestPrice = -1;
		let threshold = 0;

		//Ermittlung der zu verlagernde Energie
		for (let i = this.now.idx + 1; i < toIdx; i++) {
			if (smallestPrice === -1 || smallestPrice > prices[i].total) smallestPrice = prices[i].total;
			threshold = Math.round(smallestPrice * (1 + this.iBattery.chargingLosses / 100) * 1000) / 1000; //Preisschwelle

			if (tbl[i].grid > 0 && prices[i].total > threshold) {
				const chargingEnergy = Math.round(tbl[i].grid * (1 + this.iBattery.chargingLosses / 100)); //+17% mehr Energie laden
				ret.push({ threshold: threshold, total: chargingEnergy * prices[i].total, energy: chargingEnergy, start: i });
			}
		}
		//Sortiert teuer zu günstig
		ret.sort(function (a, b) {
			return b.total - a.total;
		});

		this.adapter.log.debug(`EMS._highRange ${JSON.stringify(ret)}`);
		return ret;
	}
	//Tibber
	_putInLowZone(highRange, soc) {
		const loadPoint = [];
		const prices = this.iPrices.jsonData; //aktuelle Preise holen

		this._lockDisCharging(this.load, highRange);
		highRange = this._searchHighPrices(soc);
		//relevante Ladepunkte suchen, die günstiger als die Preisgrenze sind
		for (let k = 0; k < highRange.length; k++) {
			const relLP = []; //relevanten Ladepunkte
			for (let i = this.now.idx + 1; i < highRange[k].start; i++) {
				//console.log(' idx '+i+' price '+prices[i].total+' dprice '+highRange[k].dPrice);
				//günstiger als Preisschwelle
				if (prices[i].total < highRange[k].threshold) {
					relLP.push({ idx: i, price: prices[i].total, threshold: highRange[k].threshold });
				}
			}
			//relevante Ladepunkte nach Einstandspreis sortieren
			relLP.sort(function (a, b) {
				return a.price - b.price;
			});

			let rest = highRange[k].energy; //welche Energy soll nach vorn verlagert werden
			//rest += (highRange[k].start - this.nowIdx)*64; //64 W Stanby-By Verluste
			//console.log('Rest '+rest);

			for (let i = 0; i < relLP.length; i++) {
				let energy = rest;

				const overLoad = this.iBattery.simulateCharge(this.load, relLP[i].idx, energy, soc);
				if (overLoad > 0) energy -= overLoad;
				energy = Math.round(energy);
				if (energy > 0) {
					//console.log('energy '+energy);
					const exist = loadPoint.findIndex(x => x.idx == relLP[i].idx);
					if (exist > -1) {
						loadPoint[exist].charge += energy;
						//kleinster verlagerter high price Punkt
						if (highRange[k].start < loadPoint[exist].start) loadPoint[exist].start = highRange[k].start;
					} else {
						loadPoint.push({
							idx: relLP[i].idx,
							time: this.load[relLP[i].idx].time,
							charge: energy,
							price: relLP[i].price,
							start: highRange[k].start,
							soc: 0,
						});
					}

					if (this.load[relLP[i].idx].chargedEnergy > 0) {
						this.load[relLP[i].idx].chargedEnergy += energy;
					} else {
						this.load[relLP[i].idx].chargedEnergy = energy;
					}
				}

				if (energy > 0) rest -= energy;
				if (rest === 0) break;
			}
		}

		//kleine Loads entfernen
		for (let i = 0; i < loadPoint.length; i++) {
			if (loadPoint[i].charge < 200) {
				this.load[loadPoint[i].idx].chargedEnergy -= loadPoint[i].charge;
				if (this.load[loadPoint[i].idx].chargedEnergy < 0) this.load[loadPoint[i].idx].chargedEnergy = 0;
				//console.log(' remove '+loadPoint[i].idx+' i '+i);
				loadPoint.splice(i, 1);
				i -= 1;
			}
		}

		return loadPoint;
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
		let minSoc = this.inverter.dischargeCutoffCapacity; //mindestens auf Entladegrenze setzen
		let bufferSOC = 0;
		let consum = 0;
		let pv = 0;

		let tbl = this.iBattery.getSOCTable(this.load, this.load.length /* this.iPrices.jsonData.length */, this.SOC, true);
		if (this.debug === 2) {
			this.adapter.log.debug(`forcastBasedCharging tbl - allowNegative  ${JSON.stringify(tbl)}`);
		}
		//Ermittlung des kleinsten SOC in der restlichen Zeit
		let smallestSoc = 100; //starten bei 100%
		for (let i = this.now.idx; i < this.load.length; i++) {
			consum += this.load[i].consumption;
			pv += this.load[i].pv;
			if (tbl[i].soc < smallestSoc) smallestSoc = tbl[i].soc;
		}
		if (this.debug === 2) {
			this.adapter.log.debug(`forcastBasedCharging consum ${consum} pv ${pv} smallestSoc ${smallestSoc} SOC ${this.SOC} minSoc ${minSoc}`);
		}
		//Ermittlung des Überschusses
		const overSoc = Math.round(smallestSoc - minSoc);
		if (this.SOC - overSoc > minSoc) minSoc = this.SOC - overSoc;
		if (minSoc > this.inverter.chargingCutoffCapacity) minSoc = this.inverter.chargingCutoffCapacity;
		await this.inverter.setSurplusMinSoc(minSoc);
		//PufferSOC auf minSoc + 15% setzen
		bufferSOC = minSoc + 15;
		if (bufferSOC > 100) bufferSOC = 100;
		await this.inverter.setSurplusBufferSoc(bufferSOC);

		tbl = this.iBattery.getSOCTable(this.load, this.load.length /* this.iPrices.jsonData.length */, minSoc, true);
		if (this.debug === 2) {
			this.adapter.log.debug(`forcastBasedCharging overSOC ${overSoc}`);
			this.adapter.log.debug(`forcastBasedCharging new minSOC ${minSoc}`);
			this.adapter.log.debug(`forcastBasedCharging tbl - allowNegative  ${JSON.stringify(tbl)}`);
			this.adapter.log.debug(`forcastBasedCharging ${JSON.stringify(this._getSurplusToday(this.now.idx))}`);
		}

		if (this.load[this.now.idx]?.lockCharging) {
			let charge = this.SOC < minSoc;
			await this.inverter.setCharging(charge);
		} else {
			let charge = true;
			//möglichst den Speicher nur Laden bis 85%
			if (bufferSOC < 85 && this.SOC >= 85 && this.SOC < this.inverter.chargingCutoffCapacity) {
				const energyToFull = ((this.inverter.chargingCutoffCapacity - this.SOC) * this.inverter.ratedCapacity) / 100;
				const surplus = this._getSurplusToday(this.now.idx)?.surplus ?? 0;
				if (energyToFull < surplus) charge = false; //??
				this.adapter.log.debug(`processForcastBasedCharging energyToFull ${energyToFull} < surplus ${surplus} charge ${charge}`);
			}
			await this.inverter.setCharging(charge);
		}
	}

	async optimizeCharging() {
		//this.newChargingPoints; //??
		this.SOC = await this.inverter.getSOC();

		await this.iPrices.update(); //Tibberpreise holen
		this.prices = this.iPrices.jsonData;
		//Ladetabelle holen
		await this.iLoad.update(); //LastProfile aus PVForcast erstellen
		this.load = this.iLoad.jsonData; //Last Tabelle holen
		if (this.debug > 0) {
			this.adapter.log.debug(`#### OptimizeCharging Start ####`);
			this.adapter.log.debug(`getSOC ${this.SOC}`);
			this.adapter.log.debug(`Tibber prices: ${JSON.stringify(this.prices)}`);
			//Test Tibber
			if (this.debug > 1) {
				for (let i = 0; i < this.load.length; i++) {
					this.load[i].consumption = 300; //+Math.round(Math.random()*200);
					if (i >= 8 && i < 16) this.load[i].consumption += 200; //Mittagszeit
					if (i >= 16 && i < 20) this.load[i].consumption += 400; //Abendzeit
					if (i >= 20) this.load[i].consumption += 200; //Nachtzeit
					this.load[i].pv = 0;
					if (i >= 6 && i < 18) {
						this.load[i].pv = Math.round(1000 * Math.sin(((i - 6) / 12) * Math.PI)); //PV Erzeugung
					}
				}
			}
		}

		this.now.renew(this.iLoad.jsonData[0].time);

		// Tibber --
		const highPrices = this._searchHighPrices(this.SOC);
		this.newChargingPoints = this._putInLowZone(highPrices, this.SOC);

		this.tbl = this.iBattery.getSOCTable(this.load, this.load.length, this.SOC);

		//Ziel SOC Werte zu den Ladepunkten hinzufügen
		for (let i = 0; i < this.newChargingPoints.length; i++) {
			this.newChargingPoints[i].soc = this.tbl[this.newChargingPoints[i].idx].soc;
		}
		//Sortiert nach idx
		this.newChargingPoints.sort(function (a, b) {
			return a.idx - b.idx;
		});
		//Tibber ++

		//Grid Friendly Feed-In
		this._gridFriendlyFeedIn(); //im Sommer: Energie zeitversetzt Einspeisen

		//this.tbl = this.iBattery.getSOCTable(this.load, this.load.length /*this.iPrices.jsonData.length*/, this.SOC);

		//Tibber Preise
		for (let i = 0; i < this.tbl.length; i++) {
			this.tbl[i].price = this.prices[i]?.total ?? 0;
		}

		if (this.debug > 0) {
			this.adapter.log.debug(`newChargingPoints ${JSON.stringify(this.newChargingPoints)}`);
			this.adapter.log.debug(`Load table ${JSON.stringify(this.load)}`);
			this.adapter.log.debug(`soc tbl ${JSON.stringify(this.tbl)}`);
			this.adapter.log.debug(`#### OptimizeCharging Ende ####`);
		}
	}

	adjustPower(soc, duration) {
		const restEnergy = ((this.process.soc - soc) * this.inverter.ratedCapacity) / 100;
		let power = (restEnergy / duration) * 60000 * 60 * (1 + this.iBattery.chargingLosses / 200); //+10%
		if (power > this.inverter.maximumChargePower) power = this.inverter.maximumChargePower;
		if (power < 0) power = 0;
		power = Math.round(power);
		this.adapter.log.debug(`Adjust Power ${power}`);
		return power;
	}

	async controlCharging(restTime) {
		this.SOC = await this.inverter.getSOC();
		//Lädt die Batterie?
		if (this.SOC < this.process.soc) {
			const chargePower = await this.inverter.getDischargePower();
			if (chargePower <= 0) {
				this.adapter.log.warn('Battery not charging!');
			}
		}
		const power = this.adjustPower(this.SOC, restTime);
		if (!this.process.lastPower || Math.abs(this.process.lastPower - power) > 50) {
			await this.inverter.setChargePower(power);
			this.process.lastPower = power;
		}
	}

	async processing() {
		//keine Processphase aktiv oder phase=0
		if (!this.process.phase) {
			if (Object.keys(this.process).length === 0) {
				this.chargingPoints = [...this.newChargingPoints];
				//this.adapter.log.debug('New ChargingPoints '+JSON.stringify(this.chargingPoints));
			}
			let processId = -1;
			//this.chargingPoints[0].time = '2025-01-16 16:30:00';
			const processBefore = this.process;
			//aktuellen Process suchen...
			for (let i = 0; i < this.chargingPoints.length; i++) {
				const dt = new Date(this.chargingPoints[i].time);
				dt.setMinutes(dt.getMinutes() - 45); //Startzeit: WakeUp
				const dEnd = new Date(this.chargingPoints[i].time);
				dEnd.setMinutes(dEnd.getMinutes() + 60); //Endzeit
				if (this.now.date >= dt && this.now.date < dEnd) {
					this.adapter.log.debug(
						`${JSON.stringify(this.chargingPoints[i])} start at ${tools.toDateString(dt)} start end ${tools.toDateString(dEnd)}`,
					);
					this.process = this.chargingPoints[i];
					processId = i;
				}
			}
			//Neuen Process gefunden
			if (processId >= 0) {
				//Über wie viele Processe soll zusammenhängend geladen werden
				this.process.hours = 1;
				for (let k = processId + 1; k < this.chargingPoints.length; k++) {
					if (this.chargingPoints[k - 1].idx + 1 === this.chargingPoints[k].idx) {
						this.process.hours++;
					} else {
						break;
					}
				}
				//Ladevorgang noch aktiv -> Anschlussprocess
				if (processBefore.phase === 0) {
					this.process.phase = 3; //Charge Control
				} else {
					this.process.phase = 1; //Wake up
				}
				this.adapter.log.debug(`New Process ${JSON.stringify(this.process)}`);
			} else {
				//keinen neuen Process gefunden
				//vorherigen Process gefunden -> Unterbrechnung der Ladung
				if (processBefore.phase === 0) {
					await this.inverter.stopCharging();
					this.process = {}; //Ende
				}
			}
		}

		if (this.process.phase > 0) {
			const dt = new Date(this.process.time);
			const dEnd = new Date(this.process.time);
			dEnd.setMinutes(dEnd.getMinutes() + 60); //Endzeit

			//console.log('Aktuelle phase '+JSON.stringify(this.process));
			if (this.now.date >= dt && this.now.date < dEnd) {
				//Battery wake up
				if (this.process.phase === 1) {
					if (await this.inverter.wakeUp()) {
						this.adapter.log.debug('Battery was waken up');
						this.process.phase = 2;
					} else {
						if (this.now.date > dt) this.adapter.log.warn('Battery cannot be woken up!');
					}
				}
				//Start to load Battery
				if (this.process.phase === 2) {
					dt.setMinutes(dt.getMinutes() - 1); //1 Minute vorverlegn
					if (this.now.date >= dt) {
						const untilDt = new Date(this.process.time);
						untilDt.setMinutes(untilDt.getMinutes() + this.process.hours * 60); //Endzeit
						const duration = untilDt.getTime() - this.now.date.getTime();
						this.SOC = await this.inverter.getSOC();
						const power = this.adjustPower(this.SOC, duration);
						this.process.lastPower = power;
						this.adapter.log.info('Start charging ...');
						if (await this.inverter.startcharging(power, duration)) this.process.phase = 3;
					}
				}
				//ChargeControl
				if (this.process.phase === 3) {
					if (!this.process.lastLoop) this.process.lastLoop = this.now.date.getTime();
					if (this.now.date.getTime() - this.process.lastLoop >= 60000 * 5) {
						//alle 5 Minuten
						this.adapter.log.info('Control Charging...');
						await this.controlCharging(dEnd.getTime() - this.now.date.getTime());
						this.process.lastLoop = this.now.date.getTime(); //ms
					}
				}
			} else {
				//Ende des Processes
				this.process.phase = 0;
			}
		}
	}

	async updateAverages() {
		await this.inverter.getDischargeCutoffCapacity();
		this.SOC = await this.inverter.getSOC();
		this.averageChargePower.newValue = (await this.inverter.getChargeDischargePower()) * 1000;
		this.averageConsumption.newValue = (await this.inverter.getConsumption()) * 1000;
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

	//ChargeFromGrid
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

	//Hohe Entladung des Speichers verhindern z.B. durch Laden des E-Autos
	async batteryProtection() {
		//console.log('Speicherladung: averageChargePower '+this.averageChargePower.value+' , averageConsumption '+this.averageConsumption.value);
		if (this.averageChargePower.value > this.inverter.maximumChargePower - 500 && this.averageConsumption.value > this.inverter.maximumChargePower) {
			this.adapter.log.info(`Hohe Speicherentladung --> Sperrung : ${this.averageChargePower.value}`);
			await this.inverter.setDisCharging(true);
		} else {
			//Hohe Last fällt weg
			if (!this.load[this.now.idx]?.lockDischarging) {
				//this.adapter.log.info('Geringe Speicherentladung --> setDisCharging(false)')
				await this.inverter.setDisCharging(false);
			}
		}
	}

	async processOn() {
		//für die nächste Stunde
		this.now.renew(this.iLoad.jsonData[0].time);
		await this.inverter.setDisCharging(this.load[this.now.idx]?.lockDischarging ?? false);
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

		await this.processOn();

		this.scheduleHandle = cron.schedule('59 * * * *', async () => {
			//if ( Object.keys(this.process).length === 0 ) this.chargingPoints = await this.getCharingPoints();
			//this.newChargingPoints = await this.getCharingPoints();
			await this.optimizeCharging();
		});

		this.scheduleHandle2 = cron.schedule('0 * * * *', async () => {
			await this.processOn();
		});

		this.loopHandle = setInterval(async () => {
			this.now.renew(this.iLoad.jsonData[0].time);
			await this.updateAverages();

			await this.processing(); // Tibber
			await this.forcastBasedCharging();

			if (Object.keys(this.process).length !== 0) return;
			//await this.reduceBatteryLosses();
			await this.batteryProtection();
			await this.chargeFromGrid();
		}, 300000); //1000*60*60*5 Minuten

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
		this.loopHandle && this.adapter.clearInterval(this.loopHandle);
		this.mitnightTimer && this.adapter.clearTimeout(this.mitnightTimer);
		this.scheduleHandle && this.scheduleHandle.stop();
		this.scheduleHandle2 && this.scheduleHandle2.stop();
	}
} //End of CLASS EMS

export default EMS;
