'use strict';

const Homey = require('homey');
const { distanceMeters } = require('../../lib/geo');
const { filterLocation } = require('../../lib/filterLocation');
const { confirmZoneChange } = require('../../lib/confirmZones');
const { renderUserMapImage, renderJourneyMapImage, buildJourneys } = require('../../lib/mapImage');
const { readTrack, splitTrack } = require('../../lib/trackStorage');

const TRACK_MIN_DISTANCE_METERS = 50;
const TRACK_MAX_POINTS = 1000;
const SPEED_STALE_MS = 60 * 1000;
const LOCATION_REQUEST_DELAY_MS = 30 * 1000;
const MAP_REFRESH_DELAY_MS = 15 * 1000;
const MAP_REFRESH_MEMORY_PAUSE_MS = 5 * 60 * 1000;
const KMH_TO_MPH = 0.621371;
const JOURNEY_IMAGE_COUNT = 2;
// Broker reconnects/app restarts can replay a whole backlog of queued or retained location
// reports at once, each looking like a real transition relative to the reset in-memory
// debounce state. Treat every zone change seen in this window after (re)start as a resync.
const ZONE_SYNC_GRACE_MS = 2 * 60 * 1000;

module.exports = class UserDevice extends Homey.Device
{

	// A class field so it's set the instant the device object is constructed, NOT just once
	// onInit runs - MQTT location reports can reach _considerZoneChange (via the app/driver's
	// device list) before this device's own onInit has had a chance to execute.
	zoneSyncGraceUntil = Date.now() + ZONE_SYNC_GRACE_MS;

	async onInit()
	{
		this.log(`User device initialized: ${this.getName()} (${this.getData().id})`);
		this.speedStaleTimer = null;
		this.locationRequestTimer = null;
		this.mapRefreshTimer = null;
		this.mapRefreshPausedUntil = 0;
		this.latestVelocityKmh = null;
		this.pendingLocation = null;
		this.pendingZoneChange = null;
		// Zone changes seen before this time just resync to the current zone, they must never
		// re-fire entered/left flows for transitions that happened/queued while the app was down.
		this.zoneSyncGraceUntil = Date.now() + ZONE_SYNC_GRACE_MS;

		if (!this.hasCapability('speed'))
		{
			await this.addCapability('speed');
		}
		await this.updateSpeedUnit();

		if (!this.getSetting('userId'))
		{
			// First run after pairing: seed the editable userId from the immutable device id.
			await this.setSettings({ userId: this.getData().id }).catch(this.error);
		}
		await this.homey.app.restoreImportedUser(this).catch(this.error);
		await this._initializeZonesFromLastCoordinates();

		this._loadTrackingSettings();
		await this.replaceTrackHistory(this.getTrackHistory());
		this.onAppSettingsChanged = () => this._loadTrackingSettings();
		this.homey.settings.on('set', this.onAppSettingsChanged);
		await this._setupImages().catch(this.error);
		await this._refreshHttpEndpoint().catch(this.error);
		this.homey.app.requestUserLocation(this);
	}

	async onUninit()
	{
		if (this.speedStaleTimer)
		{
			clearTimeout(this.speedStaleTimer);
		}
		if (this.locationRequestTimer)
		{
			clearTimeout(this.locationRequestTimer);
		}
		if (this.mapRefreshTimer)
		{
			clearTimeout(this.mapRefreshTimer);
		}
		if (this.onAppSettingsChanged)
		{
			this.homey.settings.off('set', this.onAppSettingsChanged);
		}
	}

	async onDeleted()
	{
		for (const image of [this.mapImage, ...(this.journeyImages || [])])
		{
			if (image)
			{
				await image.unregister().catch(this.error);
			}
		}
		this.mapImage = null;
		this.journeyImages = [];
	}

	async _createImage(render)
	{
		const image = await this.homey.images.createImage();
		image.setStream(async (stream) =>
		{
			let buffer;
			try
			{
				buffer = await render();
				stream.contentType = 'image/png';
				stream.contentLength = buffer.length;
				stream.filename = `${this.getData().id}.png`;
				stream.write(buffer);
				stream.end();
			}
			finally
			{
				buffer = null;
			}
		});

		return image;
	}

	/**
	 * Registers this user's live map picture plus one picture per recent journey. Images are only
	 * rendered when Homey pulls the stream, so nothing is drawn while no one is looking.
	 */
	async _setupImages()
	{
		this.mapImage = await this._createImage(() => renderUserMapImage({
			location: this.getStoreValue('lastLocation'),
			track: this.getTrackHistory(),
			journeyGapMinutes: Number(this.homey.settings.get('journeyGapMinutes')) || 30,
			zone: this.getCapabilityValue('zone'),
			speed: this.getCapabilityValue('speed'),
			useMiles: this.homey.settings.get('speedUnit') === 'mph',
			onError: (err) => this.error('Map tile failed', err),
		}));
		await this.setCameraImage('map', this.homey.__('device.mapImage'), this.mapImage);

		// getTimezone() returns a plain string on some Homey versions and a promise on others.
		try
		{
			this.timezone = await this.homey.clock.getTimezone();
		} catch (err)
		{
			this.timezone = undefined;
		}

		this.journeyImages = [];
		for (let index = 0; index < JOURNEY_IMAGE_COUNT; index++)
		{
			this.journeyImages.push(await this._createImage(() => renderJourneyMapImage({
				journey: this._listJourneys()[index],
				useMiles: this.homey.settings.get('speedUnit') === 'mph',
				onError: (err) => this.error('Map tile failed', err),
			})));
		}
		await this._syncJourneyImages();
	}

	_listJourneys()
	{
		const gapMinutes = Number(this.homey.settings.get('journeyGapMinutes')) || 30;
		// Oldest first, so reading down the list follows the user forwards in time.
		return buildJourneys(this.getTrackHistory(), gapMinutes * 60 * 1000)
			.slice(0, JOURNEY_IMAGE_COUNT)
			.reverse();
	}

	/**
	 * Slot N always shows the Nth oldest of the recent journeys, so every title has to be
	 * rewritten once a new journey starts (or an old one is trimmed off the track).
	 */
	async _syncJourneyImages(refreshNewest = true)
	{
		const journeys = this._listJourneys().map((journey) => ({ journey, zones: this._journeyZoneLabel(journey) }));
		const signature = journeys.map((entry) => `${entry.journey.start}:${entry.zones}`).join('|');
		const shifted = signature !== this.journeySignature;
		this.journeySignature = signature;

		for (let index = 0; index < journeys.length; index++)
		{
			if (shifted)
			{
				const { journey, zones } = journeys[index];
				const title = `${this.homey.__('device.journeyImage')} ${this._formatJourneyStart(journey)}${zones ? ` (${zones})` : ''}`;
				await this.setCameraImage(`journey${index}`, title, this.journeyImages[index]).catch(this.error);
			}
			// Only the newest journey gains points; re-pulling the older, unchanged ones would just
			// cost tile fetches.
			if (shifted || (refreshNewest && index === journeys.length - 1))
			{
				await this.journeyImages[index].update().catch(this.error);
			}
		}
	}

	/**
	 * "Home → Work" for a journey that both starts and ends in a known zone. Either side is left
	 * off when the user wasn't in a zone there, and a round trip just names the one zone.
	 */
	_journeyZoneLabel(journey)
	{
		const first = journey.points[0];
		const last = journey.points[journey.points.length - 1];
		const from = this._findWaypointZones(first.lat, first.lon)[0];
		const to = this._findWaypointZones(last.lat, last.lon)[0];

		if (from && to)
		{
			return from === to ? from : `${from} → ${to}`;
		}
		if (from)
		{
			return `${from} →`;
		}
		if (to)
		{
			return `→ ${to}`;
		}

		return '';
	}

	_formatJourneyStart(journey)
	{
		try
		{
			return new Intl.DateTimeFormat('en-GB', {
				day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: this.timezone,
			}).format(new Date(journey.start));
		} catch (err)
		{
			return new Date(journey.start).toLocaleString();
		}
	}

	_refreshMapImage()
	{
		if (Date.now() < this.mapRefreshPausedUntil) return;
		if (this.mapRefreshTimer) return;
		this.mapRefreshTimer = setTimeout(() =>
		{
			this.mapRefreshTimer = null;
			if (this.mapImage)
			{
				this.mapImage.update().catch(this.error);
			}
			if (this.journeyImages && this.journeyImages.length)
			{
				this._syncJourneyImages(false).catch(this.error);
			}
		}, MAP_REFRESH_DELAY_MS);
	}

	pauseMapImageRefreshes()
	{
		this.mapRefreshPausedUntil = Date.now() + MAP_REFRESH_MEMORY_PAUSE_MS;
		if (this.mapRefreshTimer)
		{
			clearTimeout(this.mapRefreshTimer);
			this.mapRefreshTimer = null;
		}
	}

	_scheduleLocationRequest(velocity)
	{
		if (this.locationRequestTimer)
		{
			clearTimeout(this.locationRequestTimer);
			this.locationRequestTimer = null;
		}

		if (typeof velocity !== 'number' || !Number.isFinite(velocity) || velocity <= 0)
		{
			// A user who stops just outside a zone would otherwise never send the reports needed
			// to confirm they left it.
			if (!this.pendingZoneChange)
			{
				return;
			}
		}

		this.locationRequestTimer = setTimeout(() =>
		{
			this.locationRequestTimer = null;
			this.homey.app.requestUserLocation(this);
			this._checkWaypointZoneFallback().catch(this.error);
		}, LOCATION_REQUEST_DELAY_MS);
	}

	_findWaypointZones(lat, lon)
	{
		if (typeof lat !== 'number' || typeof lon !== 'number')
		{
			return [];
		}

		return this.homey.app.listWaypoints(this.getData().id)
			.filter((waypoint) => typeof waypoint.lat === 'number'
				&& typeof waypoint.lon === 'number'
				&& distanceMeters(lat, lon, waypoint.lat, waypoint.lon) <= (Number(waypoint.rad) || 100))
			.map((waypoint) => waypoint.desc);
	}

	async _initializeZonesFromLastCoordinates()
	{
		if (this.getCapabilityValue('zone') !== null && this.getCapabilityValue('alarm_presence') !== null)
		{
			return;
		}

		const coordinates = String(this.getCapabilityValue('last_coordinates') || '').split(',').map(Number);
		if (coordinates.length !== 2 || !coordinates.every(Number.isFinite))
		{
			return;
		}

		const regions = this._findWaypointZones(coordinates[0], coordinates[1]);
		const zone = regions.length ? regions.join(', ') : 'Unknown';
		const isHome = regions.some((region) => this._getPresenceZones().includes(region.toLowerCase()));
		await this.setCapabilityValue('zone', zone).catch(this.error);
		await this.setCapabilityValue('alarm_presence', isHome).catch(this.error);
		this.log(`Initialized zone from last coordinates: ${zone}`);
	}

	async _checkWaypointZoneFallback()
	{
		const location = this.getStoreValue('lastLocation');
		if (!location || (Array.isArray(location.regions) && location.regions.length))
		{
			return;
		}

		const inferredRegions = this._findWaypointZones(location.lat, location.lon);
		if (inferredRegions.length)
		{
			await this._considerZoneChange(inferredRegions);
			this.log(`Inferred zone from last coordinates: ${inferredRegions.join(', ')}`);
		}
	}

	_getCurrentZones()
	{
		return String(this.getCapabilityValue('zone') || '')
			.split(',')
			.map((zone) => zone.trim())
			.filter((zone) => zone && zone !== 'Unknown');
	}

	async _considerZoneChange(regions)
	{
		if (Date.now() < this.zoneSyncGraceUntil)
		{
			// Resync to whatever the phone reports right now, without treating it as a real
			// transition - otherwise a restart replays queued/retained reports as real flows.
			this.pendingZoneChange = null;
			await this._applyZones(regions, { silent: true });
			return;
		}

		const decision = confirmZoneChange(this._getCurrentZones(), regions, this.pendingZoneChange);
		this.pendingZoneChange = decision.pendingChange;
		if (decision.shouldApply)
		{
			await this._applyZones(regions);
		} else if (decision.pendingChange !== null)
		{
			this.log(`Waiting for confirmation before changing zones to: ${regions.join(', ') || 'Unknown'}`);
		}
	}

	async _applyZones(regions, { silent = false } = {})
	{
		const zone = regions.length ? regions.join(', ') : 'Unknown';
		const isHome = regions.some((region) => this._getPresenceZones().includes(region.toLowerCase()));
		const previousZones = this._getCurrentZones();
		const currentZoneSet = new Set(regions.map((region) => region.toLowerCase()));
		const previousZoneSet = new Set(previousZones.map((previous) => previous.toLowerCase()));

		await this.setCapabilityValue('zone', zone).catch(this.error);
		await this.setCapabilityValue('alarm_presence', isHome).catch(this.error);

		if (silent)
		{
			if (previousZones.join(',') !== regions.join(','))
			{
				this.log(`Resynced zone to ${zone} on startup without triggering flows`);
			}
			return;
		}

		const enteredZones = regions.filter((current) => !previousZoneSet.has(current.toLowerCase()));
		const leftZones = previousZones.filter((previous) => !currentZoneSet.has(previous.toLowerCase()));
		for (const enteredZone of enteredZones)
		{
			const triggerCard = this.homey.flow.getDeviceTriggerCard('entered_zone');
			await triggerCard.trigger(this, { zone: enteredZone }, { zone: enteredZone });
			await this.homey.app.triggerPersonZoneEvent('entered', this.getName(), enteredZone);
		}
		for (const leftZone of leftZones)
		{
			const triggerCard = this.homey.flow.getDeviceTriggerCard('left_zone');
			await triggerCard.trigger(this, { zone: leftZone }, { zone: leftZone });
			await this.homey.app.triggerPersonZoneEvent('left', this.getName(), leftZone);
		}
	}

	async updateSpeedUnit()
	{
		const useMph = this.homey.settings.get('speedUnit') === 'mph';
		await this.setCapabilityOptions('speed', { units: useMph ? 'mph' : 'km/h' }).catch(this.error);

		if (typeof this.latestVelocityKmh === 'number')
		{
			const speed = useMph ? this.latestVelocityKmh * KMH_TO_MPH : this.latestVelocityKmh;
			await this.setCapabilityValue('speed', speed).catch(this.error);
		} else
		{
			await this.setCapabilityValue('speed', null).catch(this.error);
		}
	}

	async _updateSpeed(velocity)
	{
		if (typeof velocity !== 'number' || !Number.isFinite(velocity))
		{
			return;
		}

		this.latestVelocityKmh = velocity;
		if (this.speedStaleTimer)
		{
			clearTimeout(this.speedStaleTimer);
		}
		await this.updateSpeedUnit();
		this.speedStaleTimer = setTimeout(() =>
		{
			this.latestVelocityKmh = null;
			this.speedStaleTimer = null;
			this.setCapabilityValue('speed', null).catch(this.error);
			this._refreshMapImage();
			this.homey.api.realtime('tracks_updated', null);
		}, SPEED_STALE_MS);
	}

	/**
	 * The OwnTracks-facing identifier used for matching location reports and building the HTTP
	 * endpoint URL. Editable via the "userId" setting, independent of the immutable device id.
	 * @returns {string}
	 */
	getUserId()
	{
		return this.getSetting('userId') || this.getData().id;
	}

	async _getLocalTimestamp()
	{
		try
		{
			const timezone = this.homey.clock && typeof this.homey.clock.getTimezone === 'function'
				? await this.homey.clock.getTimezone()
				: undefined;
			return new Intl.DateTimeFormat('en-GB', {
				dateStyle: 'short',
				timeStyle: 'medium',
				timeZone: timezone || undefined,
			}).format(new Date());
		} catch (err)
		{
			return new Date().toLocaleString();
		}
	}

	/**
	 * Recomputes the read-only "HTTP endpoint URL" field from the current userId setting.
	 */
	async _refreshHttpEndpoint()
	{
		const homeyId = await this.homey.cloud.getHomeyId();

		await this.setSettings({
			httpEndpoint: `https://homey-${homeyId}.connect.athom.com/api/app/com.ady.zonetracks/events/${this.getUserId()}`,
		});
	}

	/**
	 * Validates a changed "userId" setting (must be non-empty and unique) and schedules the
	 * derived "HTTP endpoint URL" field to be refreshed afterwards. Homey doesn't allow calling
	 * setSettings() again while this save is still pending, so _refreshHttpEndpoint() is
	 * deferred until just after this handler returns.
	 * @param {{ oldSettings: object, newSettings: object, changedKeys: string[] }} event
	 */
	async onSettings({ newSettings, changedKeys })
	{
		if (changedKeys.includes('userId'))
		{
			const newUserId = (newSettings.userId || '').trim();
			if (!newUserId)
			{
				throw new Error('User ID cannot be empty');
			}

			const conflict = this.homey.drivers.getDriver('user').getDevices()
				.some((candidate) => candidate.getData().id !== this.getData().id && candidate.getUserId() === newUserId);
			if (conflict)
			{
				throw new Error(`User ID "${newUserId}" is already in use by another user`);
			}
		}

		if (changedKeys.includes('userId') || changedKeys.includes('httpEndpoint'))
		{
			// httpEndpoint is a copy-friendly text field but must stay derived/read-only, so any
			// direct edit to it is overwritten right back to the computed value.
			setImmediate(() => this._refreshHttpEndpoint().catch(this.error));
		}
	}

	/**
	 * Applies an incoming OwnTracks location report to this device's capabilities.
	 * A region matching the "Presence zones" setting (default "Home", case-insensitive) is
	 * treated as the user being present.
	 * @param {{ regions?: string[], battery?: number, velocity?: number, lat?: number, lon?: number, accuracy?: number, timestamp?: number }} location
	 */
	async updateFromLocation(location)
	{
		const filtered = filterLocation(location, this.getStoreValue('lastLocation'), this.pendingLocation);
		this.pendingLocation = filtered.pendingLocation;
		if (!filtered.accepted)
		{
			this.log(`Ignored location fix: ${filtered.reason}`);
			return;
		}

		const reportedRegions = Array.isArray(location.regions) ? location.regions : [];
		const regions = !reportedRegions.length
			? this._findWaypointZones(location.lat, location.lon)
			: reportedRegions;

		// Scheduled after the zone decision so a pending change can keep the polling alive.
		await this._considerZoneChange(regions);
		this._scheduleLocationRequest(location.velocity);
		await this.setCapabilityValue('last_seen', await this._getLocalTimestamp()).catch(this.error);
		if (typeof location.lat === 'number' && typeof location.lon === 'number')
		{
			await this.setCapabilityValue('last_coordinates', `${location.lat}, ${location.lon}`).catch(this.error);
		}

		if (typeof location.battery === 'number')
		{
			await this.setCapabilityValue('measure_battery', location.battery).catch(this.error);
		}
		await this._updateSpeed(location.velocity);

		await this.setStoreValue('lastLocation', {
			lat: location.lat,
			lon: location.lon,
			accuracy: location.accuracy,
			velocity: location.velocity,
			regions: reportedRegions,
			timestamp: location.timestamp,
			receivedAt: Date.now(),
		}).catch(this.error);

		if (location.topic)
		{
			await this.setStoreValue('lastTopic', location.topic).catch(this.error);
		}

		if (location.trackerId)
		{
			await this.setStoreValue('lastTrackerId', location.trackerId).catch(this.error);
		}

		await this._recordTrackPoint(location).catch(this.error);
		this._refreshMapImage();
		this.homey.api.realtime('tracks_updated', null);
	}

	_loadTrackingSettings()
	{
		this.trackMinDistance = Number(this.homey.settings.get('trackMinDistance')) || TRACK_MIN_DISTANCE_METERS;
		const newMaxPoints = Number(this.homey.settings.get('trackMaxPoints')) || TRACK_MAX_POINTS;
		if (newMaxPoints !== this.trackMaxPoints)
		{
			this.trackMaxPoints = newMaxPoints;
			this.trimTrackToMaxPoints().catch(this.error);
		} else
		{
			this.trackMaxPoints = newMaxPoints;
		}
	}

	async trimTrackToMaxPoints(maxPoints = this.trackMaxPoints)
	{
		const track = this.getTrackHistory();
		const removedPoints = Math.max(0, track.length - maxPoints);
		if (removedPoints > 0)
		{
			const retainedTrack = track
				.map((point, index) => ({ point, index }))
				.sort((first, second) =>
				{
					const firstTimestamp = Number.isFinite(first.point.timestamp) ? first.point.timestamp : 0;
					const secondTimestamp = Number.isFinite(second.point.timestamp) ? second.point.timestamp : 0;
					return firstTimestamp - secondTimestamp || first.index - second.index;
				})
				.slice(-maxPoints)
				.map(({ point }) => point);
			await this.replaceTrackHistory(retainedTrack, maxPoints);
			this.homey.api.realtime('tracks_updated', null);
		}
		return removedPoints;
	}

	getTrackHistory()
	{
		return readTrack(this.getStoreValue('track'), this.getStoreValue('trackArchive'));
	}

	async replaceTrackHistory(track, maxPoints = this.trackMaxPoints)
	{
		const gapMinutes = Number(this.homey.settings.get('journeyGapMinutes')) || 30;
		const stored = splitTrack(track, gapMinutes * 60 * 1000, maxPoints || TRACK_MAX_POINTS);
		// Archive first: an interrupted write can temporarily duplicate points, which readTrack
		// removes, rather than losing the previous active journey.
		await this.setStoreValue('trackArchive', stored.archive);
		await this.setStoreValue('track', stored.active);
	}

	/**
	 * Appends a track point when the user has moved far enough since the last recorded point,
	 * capping the stored history to trackMaxPoints, and pushes a realtime update for the
	 * settings page's Map tab. The required distance grows with speed (base distance plus the
	 * current speed in km/h), so fast journeys don't flood the track with closely-spaced points.
	 * @param {{ lat?: number, lon?: number, accuracy?: number, velocity?: number, timestamp?: number }} location
	 */
	async _recordTrackPoint(location)
	{
		if (typeof location.lat !== 'number' || typeof location.lon !== 'number')
		{
			return;
		}

		const track = this.getTrackHistory();
		// OwnTracks flushes fixes that were queued while offline, so a report isn't always
		// newer than the last one recorded.
		const last = track.reduce(
			(newest, point) => (!newest || (point.timestamp || 0) > (newest.timestamp || 0) ? point : newest),
			null
		);
		const speedKmh = typeof location.velocity === 'number' && Number.isFinite(location.velocity) && location.velocity > 0
			? location.velocity
			: 0;
		const requiredDistance = this.trackMinDistance + speedKmh;
		const moved = !last || distanceMeters(last.lat, last.lon, location.lat, location.lon) >= requiredDistance;

		if (!moved)
		{
			return;
		}

		track.push({
			lat: location.lat,
			lon: location.lon,
			accuracy: location.accuracy,
			velocity: location.velocity,
			timestamp: location.timestamp || Date.now(),
		});
		// The map joins the points in stored order, so a late fix inserted at the end would
		// otherwise draw a line back to where the user was at the time.
		track.sort((first, second) => (first.timestamp || 0) - (second.timestamp || 0));
		while (track.length > this.trackMaxPoints)
		{
			track.shift();
		}

		await this.replaceTrackHistory(track);
	}

	/**
	 * Reads the "Presence zones" setting into a lowercased list, defaulting to ["home"].
	 * @returns {string[]}
	 */
	_getPresenceZones()
	{
		const raw = this.getSetting('presenceZones');
		const zones = (raw || '')
			.split(',')
			.map((zone) => zone.trim().toLowerCase())
			.filter(Boolean);

		return zones.length ? zones : ['home'];
	}

	/**
	 * Builds this user's OwnTracks "card" (name + avatar) and last known "location" entries,
	 * used to populate every location report's response so all users see each other on the map.
	 * @returns {Promise<object[]>}
	 */
	async getFriendPayload()
	{
		const topic = this.getStoreValue('lastTopic');
		const topicDevice = topic && topic.split('/').filter(Boolean).pop();
		const tid = this.getStoreValue('lastTrackerId') || (topicDevice && topicDevice.slice(-2).toUpperCase()) || this.getUserId().slice(-2).toUpperCase();
		const entries = [];

		// OwnTracks parses the whole HTTP response array in one go, so a single malformed entry
		// makes it discard everything - including the zone sync. Only emit complete entries.
		if (!tid)
		{
			return entries;
		}

		const face = await this.getAvatarBase64();
		if (face)
		{
			entries.push({ _type: 'card', name: this.getName(), tid, face });
		}

		const lastLocation = this.getStoreValue('lastLocation');
		if (lastLocation && Number.isFinite(lastLocation.lat) && Number.isFinite(lastLocation.lon))
		{
			const entry = {
				_type: 'location',
				tid,
				lat: lastLocation.lat,
				lon: lastLocation.lon,
				tst: Math.round((lastLocation.timestamp || Date.now()) / 1000),
			};
			if (Number.isFinite(lastLocation.accuracy))
			{
				entry.acc = Math.round(lastLocation.accuracy);
			}
			entries.push(entry);
		}

		return entries;
	}

	/**
	 * Returns this user's uploaded avatar as base64 (set via the app settings page), or null.
	 * @returns {Promise<string|null>}
	 */
	async getAvatarBase64()
	{
		return this.getStoreValue('avatarBase64') || null;
	}

	/**
	 * Stores an uploaded avatar image (base64, no data-URI prefix) directly on the device.
	 * @param {string} base64
	 */
	async setUploadedAvatar(base64)
	{
		await this.setStoreValue('avatarBase64', base64);
	}

};
