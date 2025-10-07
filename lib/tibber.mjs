'use strict';
import * as tools from './tools.mjs';

class Tibber {
	constructor(adapterInstance) {
		this.adapter = adapterInstance;
		//this.homeId = undefined;
		this.jsonPrices = [];
	}

	async init(homeId) {
		this.homeId = homeId;
	}

	async loadTibberArray() {
		//Array of jsons
		try {
			console.log('Tibber prices loading ...');
			const jsonPricesToday = JSON.parse(await tools.getStateValue(this.adapter, `tibberlink.0.Homes.${this.homeId}.PricesToday.json`));
			const jsonPricesTomorrow = JSON.parse(await tools.getStateValue(this.adapter, `tibberlink.0.Homes.${this.homeId}.PricesTomorrow.json`));
			const jsonPrices = [...jsonPricesToday, ...jsonPricesTomorrow]; //merge array
			// indexing
			for (let h = 0; h < jsonPrices.length; h++) {
				jsonPrices[h].idx = h; //set index
			}
			console.log(jsonPrices);
			return jsonPrices;
		} catch (e) {
			console.warn(`Error load Tibber Date for home \${homeId} ${e}`);
			return [];
		}
	}

	get jsonData() {
		return this.jsonPrices;
	}

	async update() {
		this.jsonPrices = await this.loadTibberArray();
	}
} //of class Tibber

export default Tibber;
