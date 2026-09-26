'use strict';

if (process.env.DEBUG === '1')
{
	// eslint-disable-next-line node/no-unsupported-features/node-builtins, global-require
	require('inspector').open(9229, '0.0.0.0', true);
}

const Homey = require('homey');
const { randomUUID } = require('crypto');
const { createConnector, CONNECTION_METHOD_HTTP } = require('./lib/connectors');
const { buildJourneys, clearTileMemoryCache, initializeTileCache } = require('./lib/mapImage');

const SETTINGS_KEYS = [
	'connectionMethod',
	'mqttBrokerUrl',
	'mqttUseTls',
	'mqttCaCert',
	'mqttAllowSelfSigned',
	'mqttPort',
	'mqttUsername',
	'mqttPassword',
];

const SETTINGS_BACKUP_KEYS = [
	...SETTINGS_KEYS,
	'speedUnit',
	'trackMinDistance',
	'trackMaxPoints',
	'journeyGapMinutes',
	'trackPointStyle',
	'logsEnabled',
];

const MAX_LOG_BUFFER_BYTES = 20 * 1024;
const PERSISTED_LOGS_KEY = 'persistentLogs';
const LOG_PERSIST_DELAY_MS = 1000;
const WIDGET_MAX_JOURNEYS = 6;
const WIDGET_MAX_JOURNEY_POINTS = 80;
// How long a shared zone is protected from being auto-disabled after it was first sent to a
// phone, so a waypoints export the phone had already prepared can't undo the new zone.
const WAYPOINT_DELIVERY_GRACE_MS = 5 * 60 * 1000;

/** Keeps a journey's shape and its two end points while dropping detail a widget map can't resolve. */
function thinJourneyPoints(points)
{
	if (points.length <= WIDGET_MAX_JOURNEY_POINTS) return points;
	const stride = Math.ceil(points.length / WIDGET_MAX_JOURNEY_POINTS);
	const thinned = points.filter((point, index) => index % stride === 0);
	const last = points[points.length - 1];
	if (thinned[thinned.length - 1] !== last) thinned.push(last);
	return thinned;
}

module.exports = class MyApp extends Homey.App
{

	/**
	 * onInit is called when the app is initialized.
	 */
	async onInit()
	{
		this.logBuffer = this._loadPersistedLogs();
		this.logPersistTimer = null;
		this.logPersistPromise = Promise.resolve();
		if (this.persistedLogsNeedCleanup) this._persistLogs();

		this.connector = null;
		this.reconnectPromise = null;
		this.reconnectRequested = false;
		this.reconnectTimer = null;
		this.personEnteredZoneCard = this.homey.flow.getTriggerCard('person_entered_zone');
		this.personLeftZoneCard = this.homey.flow.getTriggerCard('person_left_zone');
		this.lastLocations = new Map();
		this.locationUpdateQueues = new Map();
		this.processedLocationIds = new Map();
		this.mqttWaypointSyncSignatures = new Map();
		this.mqttActiveTopics = new Set();
		this.connectionStatus = { connected: false, connecting: true, method: null, error: null };
		this.memoryWarningPromise = null;
		initializeTileCache(this.homey.settings);

		// Default "logsEnabled" to false on first run, so its state is explicit and predictable
		// rather than relying on an unset setting happening to be falsy.
		if (this.homey.settings.get('logsEnabled') === null)
		{
			this.homey.settings.set('logsEnabled', false);
		}

		// Safety net: a bad connector config (e.g. an invalid MQTT port) must never be able to
		// crash the whole app process via an uncaught exception or unhandled rejection.
		process.on('unhandledRejection', (err) => this._logError('Unhandled rejection', err));
		process.on('uncaughtException', (err) => this._logError('Uncaught exception', err));
		this.homey.on('mem_warn', () =>
		{
			this._onMemoryWarning();
		});

		this.homey.setTimeout(async () =>
		{
			try
			{
				await this._reconnect();
			}
			catch (err)
			{
				this._logError('Failed to initialize connector on startup', err);
			}
		}, 10000);

		this.homey.settings.on('set', (key) =>
		{
			if (SETTINGS_KEYS.includes(key))
			{
				if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
				this.reconnectTimer = this.homey.setTimeout(() =>
				{
					this.reconnectTimer = null;
					this._reconnect().catch((err) => this._logError('Failed to reconnect OwnTracks connector', err));
				}, 100);
			}
			if (key === 'speedUnit')
			{
				this.homey.drivers.getDriver('user').getDevices().forEach((device) =>
				{
					device.updateSpeedUnit().catch((err) => this._logError('Failed to update speed unit', err));
				});
			}
			if (key === 'logsEnabled')
			{
				this.homey.api.realtime('logs_enabled_changed', Boolean(this.homey.settings.get('logsEnabled')));
			}
		});

		this._log(`MyApp has been initialized (log messages ${this.homey.settings.get('logsEnabled') ? 'enabled' : 'disabled'})`);
	}

	async onUninit()
	{
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.logPersistTimer)
		{
			clearTimeout(this.logPersistTimer);
			this.logPersistTimer = null;
		}
		await this._persistLogs();
	}

	_onMemoryWarning()
	{
		this._logError('Memory warning received');
		if (this.memoryWarningPromise)
		{
			this._log('Memory warning handling is already in progress');
			return;
		}

		this.memoryWarningPromise = this._reduceMemoryUse()
			.catch((err) => this._logError('Failed to reduce memory use after warning', err))
			.finally(() =>
			{
				this.memoryWarningPromise = null;
			});
	}

	async _reduceMemoryUse()
	{
		const releasedTiles = clearTileMemoryCache();
		const devices = this.homey.drivers.getDriver('user').getDevices();
		devices.forEach((device) => device.pauseMapImageRefreshes());
		this._logError(`Memory warning resolved: released ${releasedTiles} in-memory map tile(s) and paused automatic map refreshes without deleting cached tiles or track history`);
	}

	/**
	 * Logs normally (this.log) and also captures the message into an in-memory ring buffer
	 * (capped at ~20KB), viewable from the settings page's Logs tab, but only when the
	 * "logsEnabled" setting is on. this.log/this.error themselves are read-only on Homey.App
	 * and can't be reassigned, hence separate wrappers.
	 */
	_log(...args)
	{
		if (this.homey.settings.get('logsEnabled'))
		{
			this._appendLogEntry('log', args);
		}
		this.log(...args);
	}

	/**
	 * Errors are always captured into the buffer, regardless of the "logsEnabled" setting.
	 */
	_logError(...args)
	{
		this._appendLogEntry('error', args, true);
		this.error(...args);
	}

	_appendLogEntry(level, args, persistImmediately = false)
	{
		const message = args.map((arg) =>
		{
			if (arg instanceof Error) return arg.stack || arg.message;
			return typeof arg === 'object' ? JSON.stringify(arg) : String(arg);
		}).join(' ');

		this.logBuffer.push(`[${new Date().toISOString()}] ${level.toUpperCase()}: ${message}`);

		while (this.logBuffer.length > 1 && Buffer.byteLength(this.logBuffer.join('\n'), 'utf8') > MAX_LOG_BUFFER_BYTES)
		{
			this.logBuffer.shift();
		}

		this._scheduleLogPersistence(persistImmediately);
		this.homey.api.realtime('log_updated', this.getLogsText());
	}

	_loadPersistedLogs()
	{
		const stored = this.homey.settings.get(PERSISTED_LOGS_KEY);
		if (!Array.isArray(stored)) return [];
		const entries = stored.filter((entry) => typeof entry === 'string');
		const cleaned = entries
			.filter((entry) => !entry.includes('SYSTEM: Startup before app settings initialization:')
				&& !entry.includes('SYSTEM: Startup after app settings initialization:')
				&& !entry.includes('SYSTEM: Startup after connector initialization:'))
			.map((entry) => entry.replace(/ \((?:RSS|V8 heap).*\)$/, ''));
		this.persistedLogsNeedCleanup = cleaned.length !== entries.length
			|| cleaned.some((entry, index) => entry !== entries[index]);
		return cleaned;
	}

	_scheduleLogPersistence(immediately = false)
	{
		if (this.logPersistTimer && !immediately) return;
		if (this.logPersistTimer)
		{
			clearTimeout(this.logPersistTimer);
			this.logPersistTimer = null;
		}

		const persist = () =>
		{
			this.logPersistTimer = null;
			this._persistLogs();
		};
		if (immediately) persist();
		else this.logPersistTimer = setTimeout(persist, LOG_PERSIST_DELAY_MS);
	}

	_persistLogs()
	{
		const snapshot = [...this.logBuffer];
		this.logPersistPromise = this.logPersistPromise
			.then(() => this.homey.settings.set(PERSISTED_LOGS_KEY, snapshot))
			.catch((err) => this.error('Failed to persist app logs', err));
		return this.logPersistPromise;
	}

	/**
	 * @returns {string} The last ~20KB of logged messages, newest last.
	 */
	getLogsText()
	{
		return (this.logBuffer || []).join('\n');
	}

	/**
	 * Empties the in-memory log buffer.
	 */
	clearLogs()
	{
		this.logBuffer = [];
		this._scheduleLogPersistence(true);
		this.homey.api.realtime('log_updated', this.getLogsText());
	}

	/**
	 * Emails the current log buffer using the SMTP details from env.json.
	 */
	async emailLogs()
	{
		// Emailing logs is exceptional; loading Nodemailer at startup costs roughly 17 MB RSS.
		// eslint-disable-next-line global-require
		const nodemailer = require('nodemailer');
		const transporter = nodemailer.createTransport({
			host: Homey.env.MAIL_HOST,
			port: 465,
			secure: true,
			auth: {
				user: Homey.env.MAIL_USER,
				pass: Homey.env.MAIL_SECRET,
			},
		});

		await transporter.sendMail({
			from: Homey.env.MAIL_USER,
			to: Homey.env.MAIL_RECIPIENT,
			subject: 'ZoneTracks - App Logs',
			text: this.getLogsText() || '(no log messages)',
		});
	}

	/**
	 * @returns {{ connected: boolean, method: string|null, error: string|null }}
	 */
	getConnectionStatus()
	{
		return this.connectionStatus;
	}

	/**
	 * Forwards an OwnTracks HTTP mode payload to the active connector.
	 * Called by api.js when a request hits the app's events endpoint.
	 * @param {object} body The parsed JSON body posted by OwnTracks.
	 * @param {{ user?: string, device?: string }} [context] Optional user/device hints (e.g. the userId path parameter).
	 */
	async handleOwnTracksHttp(body, context)
	{
		if (!this.connector || this.connector.constructor.name !== 'HttpConnector')
		{
			throw new Error('The app is not configured for HTTP connections');
		}
		await this.connector.ingest(body, context);
	}

	/**
	 * @param {string} user
	 * @param {string} device
	 * @returns {object|undefined} The last known location for the given user/device.
	 */
	getLastLocation(user, device)
	{
		return this.lastLocations.get(`${user}/${device}`);
	}

	/**
	 * The most recently reported position of any paired user, used by the settings page to
	 * centre the map when adding a zone. Falls back to Homey's own configured location (the
	 * `homey:manager:geolocation` permission) when there's no user position yet.
	 * @returns {{ lat: number, lon: number }|null}
	 */
	getDefaultMapLocation()
	{
		let devices;
		try
		{
			devices = this.homey.drivers.getDriver('user').getDevices();
		} catch (err)
		{
			devices = [];
		}

		let newest = null;
		devices.forEach((device) =>
		{
			const location = device.getStoreValue('lastLocation');
			if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lon)) return;
			if (!newest || (location.timestamp || 0) > (newest.timestamp || 0)) newest = location;
		});

		if (newest)
		{
			const location = { lat: newest.lat, lon: newest.lon };
			this.homey.settings.set('lastMapLocation', location);
			return location;
		}

		const stored = this.homey.settings.get('lastMapLocation');
		if (stored && Number.isFinite(stored.lat) && Number.isFinite(stored.lon)) return stored;

		try
		{
			const lat = this.homey.geolocation.getLatitude();
			const lon = this.homey.geolocation.getLongitude();
			// Unset/manual mode reports 0,0 rather than throwing, which isn't a usable position.
			if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) return { lat, lon };
		} catch (err)
		{
			// Permission not yet granted (e.g. pre-update install) - fall through to null.
		}

		return null;
	}

	/**
	 * Builds "card" (name/avatar), "location" and a "cmd"/setWaypoints (shared zones) entry for
	 * every paired User device, so an OwnTracks HTTP response can show all family members (with
	 * avatars) on the same map, and keep everyone's zones in sync.
	 * @returns {Promise<object[]>}
	 */
	async buildFriendsResponse(userId)
	{
		const devices = this.homey.drivers.getDriver('user').getDevices();
		const entries = [];

		for (const device of devices)
		{
			entries.push(...await device.getFriendPayload().catch(() => []));
		}

		const requestingDevice = this._findUserDevice(userId, userId);
		const waypoints = requestingDevice ? this.listWaypoints(requestingDevice.getData().id) : this.listWaypoints();
		// OwnTracks HTTP responses only honour location/cmd/card/transition _types; a bare
		// "waypoints" entry is silently ignored, so zones must be pushed via a "cmd"/setWaypoints.
		entries.push({
			_type: 'cmd',
			action: 'setWaypoints',
			waypoints: {
				_type: 'waypoints',
				waypoints: waypoints.map((waypoint) => this._toOwnTracksWaypoint(waypoint)),
			},
		});
		if (requestingDevice)
		{
			this._setWaypointsDelivered(requestingDevice.getData().id, waypoints);
		}

		return entries;
	}

	/**
	 * @returns {{ id: string, name: string, hasAvatar: boolean, avatarBase64: string|null }[]} The
	 * paired User devices, for the settings page's avatar upload UI.
	 */
	listUsers()
	{
		return this.homey.drivers.getDriver('user').getDevices().map((device) => ({
			id: device.getData().id,
			userId: device.getUserId(),
			name: device.getName(),
			hasAvatar: Boolean(device.getStoreValue('avatarBase64')),
			avatarBase64: device.getStoreValue('avatarBase64') || null,
		}));
	}

	/**
	 * Creates a portable settings document. Per-user data is identified by the OwnTracks user ID,
	 * which remains stable when the app is moved to another Homey.
	 */
	createSettingsBackup()
	{
		const privateWaypoints = this._getPrivateWaypoints();
		const exclusions = this._getSharedExclusions();
		const devices = this.homey.drivers.getDriver('user').getDevices();
		return {
			format: 'zonetracks-settings',
			version: 1,
			settings: Object.fromEntries(SETTINGS_BACKUP_KEYS.map((key) => [key, this.homey.settings.get(key)])),
			avatars: devices.map((device) => ({
				userId: device.getUserId(),
				avatarBase64: device.getStoreValue('avatarBase64') || null,
			})),
			users: devices.map((device) => ({
				userId: device.getUserId(),
				name: device.getName(),
				settings: { presenceZones: device.getSetting('presenceZones') || '' },
				lastTopic: device.getStoreValue('lastTopic') || null,
			})),
			zones: {
				shared: this._getSharedWaypoints(),
				users: devices.map((device) =>
				{
					const deviceId = device.getData().id;
					return {
						userId: device.getUserId(),
						private: privateWaypoints[deviceId] || [],
						disabledSharedWaypointIds: exclusions[deviceId] || [],
					};
				}),
			},
		};
	}

	/** Restores a settings document created by createSettingsBackup(). */
	async restoreSettingsBackup(backup)
	{
		const supportedFormats = ['zonetracks-settings', 'homey-tracks-settings'];
		if (!backup || !supportedFormats.includes(backup.format) || backup.version !== 1
			|| !backup.settings || !backup.zones || !Array.isArray(backup.zones.shared)
			|| !Array.isArray(backup.zones.users) || !Array.isArray(backup.avatars))
		{
			throw new Error('Invalid ZoneTracks settings backup');
		}

		const restoredSettings = {};
		for (const key of SETTINGS_BACKUP_KEYS)
		{
			if (!Object.prototype.hasOwnProperty.call(backup.settings, key)) continue;
			await this.homey.settings.set(key, backup.settings[key]);
			restoredSettings[key] = backup.settings[key];
		}

		const devices = this.homey.drivers.getDriver('user').getDevices();
		const findDeviceByUserId = (userId) => devices.find((device) => device.getUserId() === userId
			|| device.getUserId().toLowerCase() === userId.toLowerCase());
		const backupUsers = new Map((Array.isArray(backup.users) ? backup.users : [])
			.filter((user) => user && typeof user.userId === 'string')
			.map((user) => [user.userId, user]));
		const avatarsByUserId = new Map(backup.avatars
			.filter((avatar) => avatar && typeof avatar.userId === 'string')
			.map((avatar) => [avatar.userId, avatar.avatarBase64]));
		const privateWaypoints = this._getPrivateWaypoints();
		const exclusions = this._getSharedExclusions();
		let restoredUsers = 0;

		backup.zones.users.forEach((user) =>
		{
			const device = findDeviceByUserId(user.userId);
			if (!device || !Array.isArray(user.private) || !Array.isArray(user.disabledSharedWaypointIds)) return;
			const deviceId = device.getData().id;
			privateWaypoints[deviceId] = user.private;
			exclusions[deviceId] = user.disabledSharedWaypointIds;
			restoredUsers += 1;
		});

		await this.homey.settings.set('sharedWaypoints', backup.zones.shared);
		await this.homey.settings.set('privateWaypoints', privateWaypoints);
		await this.homey.settings.set('sharedWaypointExclusions', exclusions);
		await this.homey.settings.set('importedUsers', backup.zones.users
			.filter((user) => user && typeof user.userId === 'string')
			.map((user) => ({
				userId: user.userId,
				name: backupUsers.get(user.userId)?.name || user.userId,
				settings: backupUsers.get(user.userId)?.settings || {},
				lastTopic: backupUsers.get(user.userId)?.lastTopic || null,
				avatarBase64: avatarsByUserId.get(user.userId) || null,
				private: user.private || [],
				disabledSharedWaypointIds: user.disabledSharedWaypointIds || [],
			})));

		for (const avatar of backup.avatars)
		{
			const device = findDeviceByUserId(avatar.userId);
			if (device && (typeof avatar.avatarBase64 === 'string' || avatar.avatarBase64 === null))
			{
				await device.setUploadedAvatar(avatar.avatarBase64);
			}
		}

		const usersToRestore = new Map(backup.zones.users
			.filter((user) => user && typeof user.userId === 'string')
			.map((user) => [user.userId, { userId: user.userId, settings: {} }]));
		backupUsers.forEach((user, userId) => usersToRestore.set(userId, user));
		for (const user of usersToRestore.values())
		{
			const device = findDeviceByUserId(user.userId);
			if (!device) continue;
			const settings = { userId: user.userId };
			if (typeof user.settings?.presenceZones === 'string') settings.presenceZones = user.settings.presenceZones;
			await device.setSettings(settings);
			if (typeof user.lastTopic === 'string') await device.setStoreValue('lastTopic', user.lastTopic);
		}

		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToAll(true);
		return { ok: true, restoredUsers, settings: restoredSettings };
	}

	listImportedUsers()
	{
		const pairedUserIds = new Set(this.homey.drivers.getDriver('user').getDevices()
			.map((device) => device.getUserId()));
		return (this.homey.settings.get('importedUsers') || [])
			.filter((user) => user && !pairedUserIds.has(user.userId))
			.map(({ userId, name }) => ({ userId, name }));
	}

	async restoreImportedUser(device)
	{
		const importedUsers = this.homey.settings.get('importedUsers') || [];
		const userId = device.getUserId();
		const importedUser = importedUsers.find((user) => user.userId === userId
			|| user.userId.toLowerCase() === userId.toLowerCase());
		if (!importedUser) return false;

		if (typeof importedUser.avatarBase64 === 'string') await device.setUploadedAvatar(importedUser.avatarBase64);
		if (typeof importedUser.settings?.presenceZones === 'string')
		{
			await device.setSettings({ presenceZones: importedUser.settings.presenceZones });
		}
		if (typeof importedUser.lastTopic === 'string') await device.setStoreValue('lastTopic', importedUser.lastTopic);

		const deviceId = device.getData().id;
		const privateWaypoints = this._getPrivateWaypoints();
		const exclusions = this._getSharedExclusions();
		privateWaypoints[deviceId] = Array.isArray(importedUser.private) ? importedUser.private : [];
		exclusions[deviceId] = Array.isArray(importedUser.disabledSharedWaypointIds)
			? importedUser.disabledSharedWaypointIds : [];
		await this.homey.settings.set('privateWaypoints', privateWaypoints);
		await this.homey.settings.set('sharedWaypointExclusions', exclusions);
		await this.homey.settings.set('importedUsers', importedUsers.filter((user) => user.userId !== importedUser.userId));
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToDevice(device, true);
		return true;
	}

	/**
	 * @returns {{ id: string, deviceId: string, name: string, avatarBase64: string|null, lastLocation: object|null, track: object[] }[]}
	 * Each paired User device's last known location and recorded track history, for the
	 * settings page's Map tab.
	 */
	listTracks()
	{
		return this.homey.drivers.getDriver('user').getDevices().map((device) => ({
			id: device.getData().id,
			// The widget's "Devices" setting selects devices by their real Homey device id
			// (`__id`, undocumented but verified against `GET /device`), not the driver's own
			// pairing id above, so both have to be sent to the widget.
			deviceId: device.__id,
			name: device.getName(),
			avatarBase64: device.getStoreValue('avatarBase64') || null,
			battery: device.getCapabilityValue('measure_battery'),
			zone: device.getCapabilityValue('zone'),
			lastLocation: device.getStoreValue('lastLocation') || null,
			track: device.getTrackHistory(),
		}));
	}

	/**
	 * Builds the payload for the map dashboard widget. Each user's history is sent as a short
	 * list of journeys rather than a raw track, because a widget re-fetches often and a full
	 * 1000-point-per-user history is far more than a small dashboard map needs.
	 *
	 * The journeys are built from the whole stored track, newest first, so the widget's journey
	 * picker lists the same trips as the settings page and the device images; the widget itself
	 * decides how many of them are shown by default (its "Show only the last journey" setting).
	 * @param {string} instanceId The widget instance id, used to remember per-widget user visibility.
	 */
	getWidgetMapData(instanceId)
	{
		const gapMilliseconds = (Number(this.homey.settings.get('journeyGapMinutes')) || 30) * 60 * 1000;
		const users = this.listTracks().map(({ track, ...user }) => ({
			...user,
			journeys: buildJourneys(track, gapMilliseconds)
				.slice(0, WIDGET_MAX_JOURNEYS)
				.map((journey) => ({
					start: journey.start,
					end: journey.end,
					points: thinJourneyPoints(journey.points),
				})),
		}));

		return {
			users,
			defaultMapLocation: this.getDefaultMapLocation(),
			waypoints: this.listMapWaypoints(),
			speedUnit: this.homey.settings.get('speedUnit') === 'mph' ? 'mph' : 'kmh',
			hiddenUserIds: this._getWidgetHiddenUsers()[instanceId] || [],
			// null means the user has never used the widget's track toggle, so its
			// "Show recent tracks" setting still decides.
			tracksVisible: this._getWidgetTracksVisible()[instanceId] ?? null,
		};
	}

	/** Remembers, per widget instance, which users the dashboard user has toggled off. */
	async setWidgetUserVisibility(instanceId, userId, visible)
	{
		if (typeof instanceId !== 'string' || !instanceId || typeof userId !== 'string' || !userId)
		{
			throw new Error('Invalid widget visibility request');
		}

		const hiddenUsers = this._getWidgetHiddenUsers();
		const hidden = new Set(hiddenUsers[instanceId] || []);
		if (visible) hidden.delete(userId);
		else hidden.add(userId);
		hiddenUsers[instanceId] = [...hidden];
		await this.homey.settings.set('widgetHiddenUsers', hiddenUsers);
		return { ok: true, hiddenUserIds: hiddenUsers[instanceId] };
	}

	_getWidgetHiddenUsers()
	{
		const hiddenUsers = this.homey.settings.get('widgetHiddenUsers');
		return (hiddenUsers && typeof hiddenUsers === 'object') ? hiddenUsers : {};
	}

	/** Remembers, per widget instance, whether the track lines and journey flags are shown. */
	async setWidgetTracksVisible(instanceId, visible)
	{
		if (typeof instanceId !== 'string' || !instanceId)
		{
			throw new Error('Invalid widget visibility request');
		}

		const tracksVisible = this._getWidgetTracksVisible();
		tracksVisible[instanceId] = visible;
		await this.homey.settings.set('widgetTracksVisible', tracksVisible);
		return { ok: true, tracksVisible: visible };
	}

	_getWidgetTracksVisible()
	{
		const tracksVisible = this.homey.settings.get('widgetTracksVisible');
		return (tracksVisible && typeof tracksVisible === 'object') ? tracksVisible : {};
	}

	async deleteJourney(userId, start, end)
	{
		const rangeStart = Number(start);
		const rangeEnd = Number(end);
		if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd) || rangeStart > rangeEnd)
		{
			throw new Error('Invalid journey time range');
		}

		const device = this._findUserDevice(userId, userId);
		if (!device)
		{
			throw new Error('User not found');
		}

		const track = device.getTrackHistory();
		const retainedTrack = track.filter((point) => !Number.isFinite(point.timestamp)
			|| point.timestamp < rangeStart || point.timestamp > rangeEnd);
		await device.replaceTrackHistory(retainedTrack);
		this.homey.api.realtime('tracks_updated', null);
		return { ok: true, deleted: track.length - retainedTrack.length };
	}

	async deleteTrackPoint(userId, timestamp, lat, lon)
	{
		const pointTimestamp = Number(timestamp);
		const pointLat = Number(lat);
		const pointLon = Number(lon);
		if (![pointTimestamp, pointLat, pointLon].every(Number.isFinite))
		{
			throw new Error('Invalid track point');
		}

		const device = this._findUserDevice(userId, userId);
		if (!device)
		{
			throw new Error('User not found');
		}

		const track = device.getTrackHistory();
		const pointIndex = track.findIndex((point) => point.timestamp === pointTimestamp
			&& point.lat === pointLat && point.lon === pointLon);
		if (pointIndex < 0)
		{
			throw new Error('Track point not found');
		}

		const retainedTrack = [...track];
		retainedTrack.splice(pointIndex, 1);
		await device.replaceTrackHistory(retainedTrack);
		this.homey.api.realtime('tracks_updated', null);
		return { ok: true };
	}

	/**
	 * Requests a fresh report from the user's last known OwnTracks MQTT topic.
	 * HTTP mode cannot initiate a request after the phone has stopped reporting.
	 * @param {import('./drivers/user/device')} device
	 * @returns {boolean} Whether an MQTT command was published.
	 */
	requestUserLocation(device)
	{
		if (!this.connector || typeof this.connector.requestLocation !== 'function')
		{
			return false;
		}

		const topic = device.getStoreValue('lastTopic');
		const requested = this.connector.requestLocation(topic);
		if (requested)
		{
			this._log(`Requested fresh location from ${device.getName()} on ${topic}/cmd`);
		}
		return requested;
	}

	_syncMqttWaypointsToDevice(device, force = false)
	{
		if (!this.connector || typeof this.connector.syncWaypoints !== 'function')
		{
			return false;
		}

		const topic = device.getStoreValue('lastTopic');
		if (!topic)
		{
			return false;
		}

		const waypoints = this.listWaypoints(device.getData().id);
		const signature = `${topic}:${JSON.stringify(waypoints)}`;
		const deviceId = device.getData().id;
		if (!force && this.mqttWaypointSyncSignatures.get(deviceId) === signature)
		{
			return false;
		}

		const synced = this.connector.syncWaypoints(topic, waypoints);
		if (synced)
		{
			this.mqttWaypointSyncSignatures.set(deviceId, signature);
			this._setWaypointsDelivered(deviceId, waypoints);
			this._log(`Synced ${waypoints.length} MQTT waypoint(s) to ${device.getName()}`);
		}
		return synced;
	}

	_syncMqttWaypointsToAll(force = false)
	{
		let devices;
		try
		{
			devices = this.homey.drivers.getDriver('user').getDevices();
		} catch (err)
		{
			return;
		}

		devices.forEach((device) => this._syncMqttWaypointsToDevice(device, force));
	}

	/**
	 * Stores an uploaded avatar image (base64, no data-URI prefix) for the given paired user.
	 * @param {string} userId
	 * @param {string} base64
	 */
	async setUserAvatar(userId, base64)
	{
		const device = this.homey.drivers.getDriver('user').getDevices()
			.find((candidate) => candidate.getData().id === userId);

		if (!device)
		{
			throw new Error(`No paired user found with id "${userId}"`);
		}

		await device.setUploadedAvatar(base64);
		await this._publishMqttCard(device);
	}

	/**
	 * For MQTT mode, publishes this user's avatar as a retained OwnTracks "card" message to the
	 * exact topic their own locations arrive on, so other users' apps (subscribed to that same
	 * topic) pick it up directly from the broker. HTTP mode already handles this via
	 * buildFriendsResponse(), so this is a no-op there.
	 * @param {import('./drivers/user/device')} device
	 */
	async _publishMqttCard(device)
	{
		if (!this.connector || typeof this.connector.publish !== 'function')
		{
			return;
		}

		const topic = device.getStoreValue('lastTopic');
		const face = await device.getAvatarBase64();
		if (!topic || !face)
		{
			return;
		}

		const cardTopic = topic.endsWith('/info') ? topic : `${topic}/info`;
		const topicDevice = topic.split('/').filter(Boolean).pop();
		const tid = device.getStoreValue('lastTrackerId') || (topicDevice && topicDevice.slice(-2).toUpperCase()) || device.getUserId().slice(-2).toUpperCase();
		const card = { _type: 'card', tid, name: device.getName(), face };
		this.connector.publish(cardTopic, card);
		this._log(`Published MQTT card: ${JSON.stringify({ topic: cardTopic, _type: card._type, tid: card.tid, name: card.name, faceBytes: Buffer.byteLength(face, 'base64') })}`);
	}

	async _reconnect()
	{
		this.reconnectRequested = true;
		if (this.reconnectPromise) return this.reconnectPromise;

		this.reconnectPromise = (async () =>
		{
			do
			{
				this.reconnectRequested = false;
				await this._replaceConnector();
			} while (this.reconnectRequested);
		})().finally(() =>
		{
			this.reconnectPromise = null;
		});

		return this.reconnectPromise;
	}

	async _replaceConnector()
	{
		if (this.connector)
		{
			this.connector.removeAllListeners();
			await this.connector.disconnect();
			this.connector = null;
		}

		const method = this.homey.settings.get('connectionMethod') || CONNECTION_METHOD_HTTP;
		this._setConnectionStatus({ connected: false, connecting: true, method, error: null });

		this.connector = createConnector(this.homey);
		this.connector.on('location', (location) => this._onLocation(location));
		this.connector.on('waypoint', (waypoint) => this._onWaypoint(waypoint));
		this.connector.on('waypoints', (report) => this._onWaypoints(report));
		this.connector.on('error', (err) =>
		{
			this._logError('OwnTracks connector error', err);
			this._setConnectionStatus({ connected: false, connecting: false, method, error: this._describeError(err) });
		});
		this.connector.on('reconnected', () =>
		{
			this._setConnectionStatus({ connected: true, connecting: false, method, error: null });
			this.mqttWaypointSyncSignatures.clear();
			this.mqttActiveTopics.clear();
			this._syncMqttWaypointsToAll(true);
		});
		this.connector.on('disconnected', () => this._setConnectionStatus({ connected: false, connecting: false, method, error: 'Disconnected from broker' }));

		try
		{
			await this.connector.connect();
			this._log(`OwnTracks connector connected (${method})`);
			this._setConnectionStatus({ connected: true, connecting: false, method, error: null });
			this.mqttWaypointSyncSignatures.clear();
			this.mqttActiveTopics.clear();
			this._syncMqttWaypointsToAll(true);
		} catch (err)
		{
			this._logError('Failed to connect OwnTracks connector', err);
			this._setConnectionStatus({ connected: false, connecting: false, method, error: this._describeError(err) });
		}
	}

	/**
	 * Translates common low-level connection errors into a user-friendly explanation, while
	 * keeping the original message for reference.
	 * @param {Error} err
	 * @returns {string}
	 */
	_describeError(err)
	{
		const message = (err && err.message) || String(err);
		const code = err && err.code;

		if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
		{
			return `Could not find the broker address - check the Broker URL is correct. (${message})`;
		}
		if (code === 'ECONNREFUSED')
		{
			return `Connection refused - check the broker address, port, and that it's running. (${message})`;
		}
		if (code === 'ETIMEDOUT' || message.includes('connack timeout'))
		{
			return `Connection timed out - check the port and whether "Use TLS" matches what the broker expects. (${message})`;
		}
		if (/not authorized|bad user name or password/i.test(message))
		{
			return `Authentication failed - check the username and password. (${message})`;
		}
		if (code === 'CERT_HAS_EXPIRED' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')
		{
			return `TLS certificate problem - check "Use TLS" is set correctly for this broker. (${message})`;
		}

		return message;
	}

	/**
	 * Updates and pushes the connector's connection status to the settings page in realtime.
	 * @param {{ connected: boolean, connecting: boolean, method: string, error: string|null }} status
	 */
	_setConnectionStatus(status)
	{
		this.connectionStatus = status;
		this.homey.api.realtime('connection_status_changed', status);
	}

	_onLocation(location)
	{
		const key = `${location.user}/${location.device}`;
		const previous = this.locationUpdateQueues.get(key) || Promise.resolve();
		const update = previous
			.catch(() => undefined)
			.then(async () =>
			{
				if (this._isDuplicateLocation(key, location))
				{
					this._log(`Ignored duplicate location report from ${key} (id=${location.messageId})`);
					return;
				}
				this.lastLocations.set(key, location);
				this._log(`Location update from ${key}: ${location.lat}, ${location.lon} at ${new Date(location.timestamp).toISOString()} (tid=${location.trackerId || 'none'}, topic=${location.topic || 'none'}, id=${location.messageId || 'none'}, trigger=${location.trigger || 'none'}, source=${location.source || 'none'}, created_at=${location.createdAt || 'none'})`);
				await this._updateUserDevice(location);
			})
			.catch((err) => this._logError('Failed to update user device', err));
		this.locationUpdateQueues.set(key, update);
		return update;
	}

	_isDuplicateLocation(key, location)
	{
		const identifier = location.messageId || `${location.timestamp}/${location.lat}/${location.lon}`;
		const identifiers = this.processedLocationIds.get(key) || [];
		if (identifiers.includes(identifier)) return true;
		identifiers.push(identifier);
		if (identifiers.length > 100) identifiers.shift();
		this.processedLocationIds.set(key, identifiers);
		return false;
	}

	async triggerPersonZoneEvent(type, deviceName, zone)
	{
		const card = type === 'entered' ? this.personEnteredZoneCard : this.personLeftZoneCard;
		await card.trigger({ user: deviceName, zone }, {});
	}

	_normalizeWaypoint(waypoint, id = null)
	{
		return {
			id: id || waypoint.id || randomUUID(),
			desc: waypoint.desc.trim(),
			lat: Number(waypoint.lat),
			lon: Number(waypoint.lon),
			rad: Number(waypoint.rad) || 100,
			tst: waypoint.tst || Math.round(Date.now() / 1000),
		};
	}

	_validateWaypoint(waypoint)
	{
		if (!waypoint || typeof waypoint.desc !== 'string' || !waypoint.desc.trim()
			|| !Number.isFinite(Number(waypoint.lat)) || !Number.isFinite(Number(waypoint.lon)))
		{
			throw new Error('A zone needs a name, latitude and longitude');
		}
	}

	_findUserDevice(user, device)
	{
		try
		{
			return this.homey.drivers.getDriver('user').getDevices().find((candidate) =>
			{
				const candidateUser = candidate.getUserId();
				return candidate.getData().id === user || candidateUser === user || candidateUser === device;
			});
		} catch (err)
		{
			return null;
		}
	}

	_waypointsEqual(left, right)
	{
		return left.desc.toLowerCase() === right.desc.toLowerCase()
			&& left.lat === right.lat && left.lon === right.lon && left.rad === right.rad;
	}

	_getSharedWaypoints()
	{
		return this.homey.settings.get('sharedWaypoints') || [];
	}

	_getPrivateWaypoints()
	{
		return this.homey.settings.get('privateWaypoints') || {};
	}

	_getSharedExclusions()
	{
		return this.homey.settings.get('sharedWaypointExclusions') || {};
	}

	_setWaypointReconciliationReady(deviceId)
	{
		const ready = this.homey.settings.get('waypointReconciliationReady') || {};
		if (ready[deviceId]) return;
		ready[deviceId] = true;
		this.homey.settings.set('waypointReconciliationReady', ready);
	}

	/**
	 * Records when each shared zone was first handed to a device. A zone the phone has never been
	 * offered must not be treated as "deleted on the phone" when it exports its full zone list.
	 * @param {string} deviceId
	 * @param {{ id: string }[]} waypoints The zones just delivered to that device.
	 */
	_setWaypointsDelivered(deviceId, waypoints)
	{
		this._setWaypointReconciliationReady(deviceId);

		const sharedIds = new Set(this._getSharedWaypoints().map((waypoint) => waypoint.id));
		const all = this.homey.settings.get('waypointDeliveredIds') || {};
		const delivered = all[deviceId] || {};
		const firstTimeSent = [];
		let changed = false;

		waypoints.forEach((waypoint) =>
		{
			// Keep the first delivery time; refreshing it on every report would keep the zone
			// permanently inside its grace period.
			if (!sharedIds.has(waypoint.id) || delivered[waypoint.id]) return;
			delivered[waypoint.id] = Date.now();
			firstTimeSent.push(waypoint.desc);
			changed = true;
		});
		Object.keys(delivered).forEach((waypointId) =>
		{
			if (sharedIds.has(waypointId)) return;
			delete delivered[waypointId];
			changed = true;
		});

		if (!changed) return;
		all[deviceId] = delivered;
		this.homey.settings.set('waypointDeliveredIds', all);
		if (firstTimeSent.length)
		{
			this._log(`Sent ${waypoints.length} zone(s) to ${deviceId}, including for the first time: ${firstTimeSent.join(', ')}`);
		}
	}

	_getDeliveredWaypoints(deviceId)
	{
		return (this.homey.settings.get('waypointDeliveredIds') || {})[deviceId] || {};
	}

	/**
	 * Strips the app's own bookkeeping fields; the phones only understand these.
	 * @param {{ desc: string, lat: number, lon: number, rad: number, tst: number }} waypoint
	 */
	_toOwnTracksWaypoint(waypoint)
	{
		return {
			_type: 'waypoint',
			desc: waypoint.desc,
			lat: waypoint.lat,
			lon: waypoint.lon,
			rad: waypoint.rad,
			tst: waypoint.tst,
		};
	}

	/** Handles an individual phone-created waypoint as private to its paired user. */
	_onWaypoint(waypoint)
	{
		const device = this._findUserDevice(waypoint.user, waypoint.device);
		if (!device || !waypoint.desc) return;

		const deviceId = device.getData().id;
		const shared = this._getSharedWaypoints();
		const sharedMatch = shared.find((item) => this._waypointsEqual(item, waypoint));
		if (sharedMatch)
		{
			this.setSharedWaypointEnabled(deviceId, sharedMatch.id, true);
			return;
		}
		const changedShared = shared.find((item) => item.desc.toLowerCase() === waypoint.desc.toLowerCase());
		if (changedShared) this.setSharedWaypointEnabled(deviceId, changedShared.id, false);

		const privateWaypoints = this._getPrivateWaypoints();
		const userWaypoints = privateWaypoints[deviceId] || [];
		const existing = userWaypoints.find((item) => item.desc.toLowerCase() === waypoint.desc.toLowerCase());
		const normalized = this._normalizeWaypoint(waypoint, existing && existing.id);
		if (existing && this._waypointsEqual(existing, normalized)) return;
		privateWaypoints[deviceId] = existing
			? userWaypoints.map((item) => item.id === existing.id ? normalized : item)
			: [...userWaypoints, normalized];
		this.homey.settings.set('privateWaypoints', privateWaypoints);
		this._log(`Private zone "${waypoint.desc}" synced from ${device.getName()}`);
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToDevice(device);
	}

	_onWaypoints(report)
	{
		const device = this._findUserDevice(report.user, report.device);
		if (!device) return;
		const deviceId = device.getData().id;
		const ready = this.homey.settings.get('waypointReconciliationReady') || {};
		if (!ready[deviceId])
		{
			this._setWaypointReconciliationReady(deviceId);
			return;
		}

		const incoming = report.waypoints || [];
		const shared = this._getSharedWaypoints();
		const exclusions = this._getSharedExclusions();
		const excluded = new Set(exclusions[deviceId] || []);
		const delivered = this._getDeliveredWaypoints(deviceId);
		shared.forEach((waypoint) =>
		{
			if (incoming.some((item) => this._waypointsEqual(item, waypoint)))
			{
				excluded.delete(waypoint.id);
				return;
			}

			// The phone can only have deleted a zone it was actually given, and it needs a moment
			// to import a newly added one - otherwise a queued export would silently undo it.
			const deliveredAt = delivered[waypoint.id];
			if (deliveredAt && Date.now() - deliveredAt > WAYPOINT_DELIVERY_GRACE_MS) excluded.add(waypoint.id);
		});
		exclusions[deviceId] = [...excluded];

		const privateWaypoints = this._getPrivateWaypoints();
		const previousPrivate = privateWaypoints[deviceId] || [];
		privateWaypoints[deviceId] = incoming
			.filter((waypoint) => !shared.some((item) => this._waypointsEqual(item, waypoint)))
			.map((waypoint) =>
			{
				const existing = previousPrivate.find((item) => item.desc.toLowerCase() === waypoint.desc.toLowerCase());
				return this._normalizeWaypoint(waypoint, existing && existing.id);
			});
		this.homey.settings.set('sharedWaypointExclusions', exclusions);
		this.homey.settings.set('privateWaypoints', privateWaypoints);
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToDevice(device);
	}

	/**
	 * Pushes the current zone list to the settings page in realtime, so it can refresh without
	 * needing to be reopened.
	 */
	_notifyWaypointsChanged()
	{
		this.homey.api.realtime('waypoints_updated', this.listMapWaypoints());
		this.homey.api.realtime('waypoint_configuration_updated', null);
	}

	/**
	 * @returns {{ desc: string, lat: number, lon: number, rad: number, tst: number }[]}
	 */
	listWaypoints(deviceId = null)
	{
		const shared = this._getSharedWaypoints();
		if (deviceId)
		{
			const excluded = new Set(this._getSharedExclusions()[deviceId] || []);
			return [...shared.filter((waypoint) => !excluded.has(waypoint.id)), ...(this._getPrivateWaypoints()[deviceId] || [])];
		}

		const all = [...shared];
		Object.values(this._getPrivateWaypoints()).flat().forEach((waypoint) =>
		{
			if (!all.some((item) => this._waypointsEqual(item, waypoint))) all.push(waypoint);
		});
		return all;
	}

	listMapWaypoints()
	{
		const configuration = this.listWaypointConfiguration();
		const waypoints = configuration.shared.map((waypoint) => ({
			...waypoint,
			scope: 'shared',
			userId: null,
		}));
		configuration.users.forEach((user) =>
		{
			user.private.forEach((waypoint) =>
			{
				if (waypoints.some((existing) => this._waypointsEqual(existing, waypoint))) return;
				waypoints.push({ ...waypoint, scope: 'private', userId: user.id });
			});
		});
		return waypoints;
	}

	listWaypointConfiguration()
	{
		const shared = this._getSharedWaypoints();
		const privateWaypoints = this._getPrivateWaypoints();
		const exclusions = this._getSharedExclusions();
		return {
			shared,
			users: this.listUsers().map((user) => ({
				id: user.id,
				name: user.name,
				shared: shared.map((waypoint) => ({ ...waypoint, enabled: !(exclusions[user.id] || []).includes(waypoint.id) })),
				private: privateWaypoints[user.id] || [],
			})),
		};
	}

	/**
	 * Adds or updates a zone (matched by name, case-insensitive) and persists it.
	 * @param {{ desc: string, lat: number, lon: number, rad: number }} waypoint
	 */
	addWaypoint(waypoint, scope = 'shared', userId = null)
	{
		this._validateWaypoint(waypoint);
		const normalized = this._normalizeWaypoint(waypoint);
		const privateWaypoints = this._getPrivateWaypoints();
		const collection = scope === 'private' ? (privateWaypoints[userId] || []) : this._getSharedWaypoints();
		if (collection.some((item) => item.desc.toLowerCase() === normalized.desc.toLowerCase())) throw new Error('A zone with this name already exists');
		if (scope === 'private')
		{
			privateWaypoints[userId] = [...collection, normalized];
			this.homey.settings.set('privateWaypoints', privateWaypoints);
		} else this.homey.settings.set('sharedWaypoints', [...collection, normalized]);
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToAll();
	}

	/**
	 * Updates an existing zone by its original name, allowing its name and location to change.
	 * @param {string} originalDesc
	 * @param {{ desc: string, lat: number, lon: number, rad: number }} waypoint
	 */
	updateWaypoint(id, waypoint, scope = 'shared', userId = null)
	{
		this._validateWaypoint(waypoint);
		const privateWaypoints = this._getPrivateWaypoints();
		const waypoints = scope === 'private' ? (privateWaypoints[userId] || []) : this._getSharedWaypoints();
		const existingIndex = waypoints.findIndex((item) => item.id === id || item.desc.toLowerCase() === String(id).toLowerCase());
		if (existingIndex < 0) throw new Error('Zone not found');

		const duplicateIndex = waypoints.findIndex((wp, index) => index !== existingIndex && wp.desc.toLowerCase() === waypoint.desc.toLowerCase());
		if (duplicateIndex >= 0) throw new Error('A zone with this name already exists');

		waypoints[existingIndex] = this._normalizeWaypoint(waypoint, waypoints[existingIndex].id);
		if (scope === 'private')
		{
			privateWaypoints[userId] = waypoints;
			this.homey.settings.set('privateWaypoints', privateWaypoints);
		} else this.homey.settings.set('sharedWaypoints', waypoints);
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToAll();
	}

	/**
	 * Removes a zone by name (case-insensitive).
	 * @param {string} desc
	 */
	removeWaypoint(id, scope = 'shared', userId = null)
	{
		if (scope === 'private')
		{
			const privateWaypoints = this._getPrivateWaypoints();
			privateWaypoints[userId] = (privateWaypoints[userId] || []).filter((item) => item.id !== id && item.desc.toLowerCase() !== String(id).toLowerCase());
			this.homey.settings.set('privateWaypoints', privateWaypoints);
		} else
		{
			const removedIds = this._getSharedWaypoints()
				.filter((item) => item.id === id || item.desc.toLowerCase() === String(id).toLowerCase())
				.map((item) => item.id);
			this.homey.settings.set('sharedWaypoints', this._getSharedWaypoints().filter((item) => !removedIds.includes(item.id)));
			const exclusions = this._getSharedExclusions();
			Object.keys(exclusions).forEach((deviceId) => { exclusions[deviceId] = exclusions[deviceId].filter((excludedId) => !removedIds.includes(excludedId)); });
			this.homey.settings.set('sharedWaypointExclusions', exclusions);
		}
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToAll();
	}

	setSharedWaypointEnabled(userId, waypointId, enabled)
	{
		if (!this._getSharedWaypoints().some((waypoint) => waypoint.id === waypointId)) throw new Error('Shared zone not found');
		const exclusions = this._getSharedExclusions();
		const excluded = new Set(exclusions[userId] || []);
		if (enabled) excluded.delete(waypointId); else excluded.add(waypointId);
		exclusions[userId] = [...excluded];
		this.homey.settings.set('sharedWaypointExclusions', exclusions);
		this._notifyWaypointsChanged();
		const device = this._findUserDevice(userId, userId);
		if (device) this._syncMqttWaypointsToDevice(device);
	}

	movePrivateWaypointToShared(userId, waypointId)
	{
		const privateWaypoints = this._getPrivateWaypoints();
		const userWaypoints = privateWaypoints[userId] || [];
		const source = userWaypoints.find((waypoint) => waypoint.id === waypointId);
		if (!source) throw new Error('Private zone not found');

		const sharedWaypoints = this._getSharedWaypoints();
		const existingShared = sharedWaypoints.find((waypoint) => waypoint.desc.toLowerCase() === source.desc.toLowerCase());
		if (existingShared && !this._waypointsEqual(existingShared, source))
		{
			throw new Error(`A different shared zone named "${source.desc}" already exists`);
		}

		const sharedWaypoint = existingShared || source;
		if (!existingShared) this.homey.settings.set('sharedWaypoints', [...sharedWaypoints, source]);
		privateWaypoints[userId] = userWaypoints.filter((waypoint) => waypoint.id !== waypointId);
		this.homey.settings.set('privateWaypoints', privateWaypoints);

		const exclusions = this._getSharedExclusions();
		exclusions[userId] = (exclusions[userId] || []).filter((excludedId) => excludedId !== sharedWaypoint.id);
		this.homey.settings.set('sharedWaypointExclusions', exclusions);
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToAll();
	}

	copyPrivateWaypoint(sourceUserId, waypointId, destinationUserIds, conflict = 'cancel')
	{
		const privateWaypoints = this._getPrivateWaypoints();
		const source = (privateWaypoints[sourceUserId] || []).find((waypoint) => waypoint.id === waypointId);
		if (!source) throw new Error('Private zone not found');
		if (conflict === 'cancel' && (destinationUserIds || []).some((destinationUserId) =>
			(privateWaypoints[destinationUserId] || []).some((waypoint) => waypoint.desc.toLowerCase() === source.desc.toLowerCase())))
		{
			throw new Error(`Zone "${source.desc}" already exists for a selected user`);
		}

		for (const destinationUserId of destinationUserIds || [])
		{
			const destination = privateWaypoints[destinationUserId] || [];
			const existingIndex = destination.findIndex((waypoint) => waypoint.desc.toLowerCase() === source.desc.toLowerCase());
			let copied = this._normalizeWaypoint(source);
			if (existingIndex >= 0 && conflict === 'replace') destination[existingIndex] = copied;
			else
			{
				if (existingIndex >= 0 && conflict === 'rename')
				{
					let suffix = 2;
					while (destination.some((waypoint) => waypoint.desc.toLowerCase() === `${source.desc} (${suffix})`.toLowerCase())) suffix++;
					copied = { ...copied, desc: `${source.desc} (${suffix})` };
				}
				destination.push(copied);
			}
			privateWaypoints[destinationUserId] = destination;
		}
		this.homey.settings.set('privateWaypoints', privateWaypoints);
		this._notifyWaypointsChanged();
		this._syncMqttWaypointsToAll();
	}

	/**
	 * Finds the "User" device matching the location's userId (the editable "userId" setting,
	 * not the immutable device id) and applies the update to it. Matches against either the
	 * topic's username or its device segment, since some setups share one broker login across
	 * all family members and only differentiate them via OwnTracks' "Device ID" instead.
	 * @param {{ user: string, device: string }} location
	 */
	async _updateUserDevice(location)
	{
		// Retained MQTT messages can arrive the instant we subscribe, before the "user" driver
		// has finished initializing - retry briefly instead of losing that first location.
		let driver;
		for (let attempt = 0; attempt < 5; attempt++)
		{
			try
			{
				driver = this.homey.drivers.getDriver('user');
				break;
			} catch (err)
			{
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		}
		if (!driver)
		{
			return;
		}

		const device = driver.getDevices().find((candidate) =>
		{
			const userId = candidate.getUserId();
			return userId === location.user || userId === location.device;
		});
		if (device)
		{
			await device.updateFromLocation(location);
			if (Number.isFinite(location.lat) && Number.isFinite(location.lon))
			{
				this.homey.settings.set('lastMapLocation', { lat: location.lat, lon: location.lon });
			}
			const firstReportThisSession = location.topic && !this.mqttActiveTopics.has(location.topic);
			if (location.topic)
			{
				this.mqttActiveTopics.add(location.topic);
			}
			this._syncMqttWaypointsToDevice(device, firstReportThisSession);
			await this._publishMqttCard(device).catch((err) => this._logError('Failed to publish MQTT card', err));
		}
	}

};
