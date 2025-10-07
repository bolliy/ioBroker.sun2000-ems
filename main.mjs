'use strict';
/*
 * Created with @iobroker/create-adapter v2.6.5
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
//const utils = require('@iobroker/adapter-core');

import * as utils from '@iobroker/adapter-core';
import * as url from 'node:url';

import ConfigMap from './lib/controls/config_map.mjs';
import EMS from './lib/ems.mjs';

// Load your modules here, e.g.:
// const fs = require("fs");

class Sun2000Ems extends utils.Adapter {
	/**
	 * @param [options]
	 */
	constructor(options) {
		super({
			...options,
			name: 'sun2000-ems',
		});

		this.control = new ConfigMap(this);
		this.ems = null;

		this.on('ready', this.onReady.bind(this));
		this.on('stateChange', this.onStateChange.bind(this));
		// this.on('objectChange', this.onObjectChange.bind(this));
		// this.on('message', this.onMessage.bind(this));
		this.on('unload', this.onUnload.bind(this));
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:

		this.log.info(`Adapter started. Config LoadTable: ${JSON.stringify(this.config.loadTable, null, 2)}`);
		if (this.config.instancePvforecast != 'none' && this.config.instanceSun2000 != 'none') {
			await this.StartProcess();
		} else {
			this.adapterDisable('*** Adapter deactivated, Adapter Settings incomplete! ***');
		}
	}

	async initPath() {
		await this.extendObject('control', {
			type: 'channel',
			common: {
				name: 'channel control',
			},
			native: {},
		});

		await this.extendObject('pvforecast', {
			type: 'channel',
			common: {
				name: 'channel pvforecast',
			},
			native: {},
		});
	}

	async StartProcess() {
		await this.initPath();
		await this.control.init();
		this.ems = new EMS(this);
		this.ems.dataPolling();
	}

	adapterDisable(errMsg) {
		this.log.error(errMsg);
		this.setForeignState(`system.adapter.${this.namespace}.alive`, false);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 *
	 * @param callback
	 */
	onUnload(callback) {
		try {
			this.log.info('cleaned everything up...');
			this.ems?.destroy();
			callback();
		} catch {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	// onObjectChange(id, obj) {
	// 	if (obj) {
	// 		// The object was changed
	// 		this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
	// 	} else {
	// 		// The object was deleted
	// 		this.log.info(`object ${id} deleted`);
	// 	}
	// }

	/**
	 * Is called if a subscribed state changes
	 *
	 * @param id
	 * @param state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === 'object' && obj.message) {
	// 		if (obj.command === 'send') {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info('send command');

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, 'Message received', obj.callback);
	// 		}
	// 	}
	// }
}

//if (require.main !== module) {
// Export the constructor in compact mode
/**
 * @param [options]
 */
//    module.exports = options => new Sun2000Ems(options);
//} else {
// otherwise start the instance directly
//    new Sun2000Ems();
//}

const modulePath = url.fileURLToPath(import.meta.url);
if (process.argv[1] === modulePath) {
	new Sun2000Ems();
}
/**
 * Adapter start entry point
 *
 * @param options tunnel options to adapter
 */
export default function startAdapter(options) {
	return new Sun2000Ems(options);
}
