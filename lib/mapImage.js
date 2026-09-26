'use strict';

const { PNG } = require('pngjs');
const { MapCanvas, drawText, measureText } = require('./mapCanvas');
const { distanceMeters } = require('./geo');

const TILE_SIZE = 256;
const TILE_URL_TEMPLATE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// OpenStreetMap's tile usage policy requires an identifying User-Agent.
const TILE_USER_AGENT = 'ZoneTracks/1.0 (Homey app; https://github.com/AdyRock/com.ady.zonetracks)';
const TILE_TIMEOUT_MS = 8000;
const TILE_CACHE_LIMIT = 256;
const TILE_MEMORY_CACHE_LIMIT = 24;
const TILE_MEMORY_CACHE_IDLE_TIMEOUT_MS = 5 * 1000;
const TILE_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Homey shows a device's picture in a square frame, so anything else gets letterboxed.
const DEFAULT_WIDTH = 600;
const DEFAULT_HEIGHT = 600;
const EDGE_PADDING = 72;
const MIN_ZOOM = 2;
const MAX_ZOOM = 17;
const SINGLE_POINT_ZOOM = 16;
const MAX_JOURNEY_POINTS = 400;
const LABEL_SCALE = 4;
const ATTRIBUTION_SCALE = 2;
const MARKER_RADIUS = 17;
const KM_TO_MILES = 0.621371;

const COLOUR_BACKGROUND = [232, 228, 220];
const COLOUR_TRACK = [24, 116, 235];
const COLOUR_TRACK_HALO = [255, 255, 255];
const COLOUR_CURRENT = [225, 58, 58];
const COLOUR_START = [40, 160, 80];
const COLOUR_ACCURACY = [24, 116, 235];
const COLOUR_WHITE = [255, 255, 255];
const COLOUR_BLACK = [0, 0, 0];

// Keep only the active compressed tiles in memory. The larger cache remains in Homey storage.
const tileCache = new Map();
let tileCacheStorage = null;
let tileMemoryCacheExpiryTimer = null;
let renderQueue = Promise.resolve();
const tileStats = {
	requests: 0,
	cacheHits: 0,
	cacheMisses: 0,
	revalidations: 0,
	upstreamFetches: 0,
	failures: 0,
};

function cacheTileInMemory(key, entry)
{
	tileCache.delete(key);
	tileCache.set(key, entry);
	while (tileCache.size > TILE_MEMORY_CACHE_LIMIT)
	{
		tileCache.delete(tileCache.keys().next().value);
	}
}

function resetTileMemoryCacheExpiry()
{
	if (tileMemoryCacheExpiryTimer) clearTimeout(tileMemoryCacheExpiryTimer);
	tileMemoryCacheExpiryTimer = setTimeout(() =>
	{
		tileMemoryCacheExpiryTimer = null;
		tileCache.clear();
	}, TILE_MEMORY_CACHE_IDLE_TIMEOUT_MS);
}

function readStoredTile(key)
{
	if (!tileCacheStorage) return null;
	const entries = tileCacheStorage.get('mapTileCache');
	if (!Array.isArray(entries)) return null;
	const stored = entries.find((entry) => entry && entry.key === key);
	if (!stored || typeof stored.buffer !== 'string' || !Number.isFinite(stored.expires)) return null;

	try
	{
		return {
			buffer: Buffer.from(stored.buffer, 'base64'),
			etag: typeof stored.etag === 'string' ? stored.etag : null,
			lastModified: typeof stored.lastModified === 'string' ? stored.lastModified : null,
			expires: stored.expires,
		};
	}
	catch (err)
	{
		return null;
	}
}

function storeTile(key, entry)
{
	if (!tileCacheStorage) return;

	const storedEntry = {
		key,
		buffer: entry.buffer.toString('base64'),
		etag: entry.etag,
		lastModified: entry.lastModified,
		expires: entry.expires,
	};
	const existing = tileCacheStorage.get('mapTileCache');
	const entries = (Array.isArray(existing) ? existing : [])
		.filter((candidate) => candidate && candidate.key !== key);
	entries.push(storedEntry);
	while (entries.length > TILE_CACHE_LIMIT)
	{
		entries.shift();
	}
	tileCacheStorage.set('mapTileCache', entries);
}

function initializeTileCache(storage)
{
	if (tileMemoryCacheExpiryTimer) clearTimeout(tileMemoryCacheExpiryTimer);
	tileMemoryCacheExpiryTimer = null;
	tileCacheStorage = storage;
	tileCache.clear();
}

function lonToWorldX(lon, zoom)
{
	return ((lon + 180) / 360) * TILE_SIZE * (2 ** zoom);
}

function latToWorldY(lat, zoom)
{
	const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
	const sin = Math.sin((clamped * Math.PI) / 180);
	return (0.5 - (Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI))) * TILE_SIZE * (2 ** zoom);
}

async function fetchTileBuffer(zoom, tileX, tileY)
{
	const tileCount = 2 ** zoom;
	if (tileY < 0 || tileY >= tileCount)
	{
		return null;
	}

	resetTileMemoryCacheExpiry();
	const wrappedX = ((tileX % tileCount) + tileCount) % tileCount;
	const key = `${zoom}/${wrappedX}/${tileY}`;
	let cached = tileCache.get(key);
	if (!cached)
	{
		cached = readStoredTile(key);
		if (cached) cacheTileInMemory(key, cached);
	}
	tileStats.requests += 1;
	if (cached && cached.expires > Date.now())
	{
		tileStats.cacheHits += 1;
		cacheTileInMemory(key, cached);
		return cached.buffer;
	}

	const url = TILE_URL_TEMPLATE
		.replace('{z}', String(zoom))
		.replace('{x}', String(wrappedX))
		.replace('{y}', String(tileY));
	const headers = { 'User-Agent': TILE_USER_AGENT, Accept: 'image/png' };
	if (cached)
	{
		tileStats.revalidations += 1;
	} else
	{
		tileStats.cacheMisses += 1;
	}
	if (cached && cached.etag)
	{
		headers['If-None-Match'] = cached.etag;
	}
	if (cached && cached.lastModified)
	{
		headers['If-Modified-Since'] = cached.lastModified;
	}
	let response;
	try
	{
		tileStats.upstreamFetches += 1;
		response = await fetch(url, {
			headers,
			signal: AbortSignal.timeout(TILE_TIMEOUT_MS),
		});
	}
	catch (err)
	{
		tileStats.failures += 1;
		throw err;
	}
	if (response.status === 304 && cached)
	{
		cached.expires = Date.now() + TILE_CACHE_TTL_MS;
		cacheTileInMemory(key, cached);
		storeTile(key, cached);
		return cached.buffer;
	}
	if (!response.ok)
	{
		tileStats.failures += 1;
		throw new Error(`Map tile ${key} request failed (${response.status})`);
	}

	const buffer = Buffer.from(await response.arrayBuffer());
	const entry = {
		buffer,
		etag: response.headers.get('etag'),
		lastModified: response.headers.get('last-modified'),
		expires: Date.now() + TILE_CACHE_TTL_MS,
	};
	cacheTileInMemory(key, entry);
	storeTile(key, entry);

	return buffer;
}

function getTileStats()
{
	const stored = tileCacheStorage && tileCacheStorage.get('mapTileCache');
	return {
		...tileStats,
		cacheSize: Array.isArray(stored) ? stored.length : tileCache.size,
		memoryCacheSize: tileCache.size,
	};
}

function clearTileMemoryCache()
{
	const removed = tileCache.size;
	if (tileMemoryCacheExpiryTimer) clearTimeout(tileMemoryCacheExpiryTimer);
	tileMemoryCacheExpiryTimer = null;
	tileCache.clear();
	return removed;
}

function clearTileCache()
{
	const memoryCacheSize = clearTileMemoryCache();
	const stored = tileCacheStorage && tileCacheStorage.get('mapTileCache');
	const storageCacheSize = Array.isArray(stored) ? stored.length : 0;
	if (tileCacheStorage) tileCacheStorage.set('mapTileCache', []);
	return { memoryCacheSize, storageCacheSize };
}

function queueRender(render)
{
	const result = renderQueue.then(render, render);
	renderQueue = result.then(() => undefined, () => undefined);
	return result;
}

async function fetchTile(zoom, tileX, tileY)
{
	const buffer = await fetchTileBuffer(zoom, tileX, tileY);
	return buffer ? PNG.sync.read(buffer) : null;
}

async function drawTiles(canvas, zoom, originX, originY, onError)
{
	const firstTileX = Math.floor(originX / TILE_SIZE);
	const lastTileX = Math.floor((originX + canvas.width - 1) / TILE_SIZE);
	const firstTileY = Math.floor(originY / TILE_SIZE);
	const lastTileY = Math.floor((originY + canvas.height - 1) / TILE_SIZE);
	for (let tileY = firstTileY; tileY <= lastTileY; tileY++)
	{
		for (let tileX = firstTileX; tileX <= lastTileX; tileX++)
		{
			try
			{
				const tile = await fetchTile(zoom, tileX, tileY);
				if (tile)
				{
					canvas.drawTile(tile, Math.round((tileX * TILE_SIZE) - originX), Math.round((tileY * TILE_SIZE) - originY));
				}
			}
			// A missing tile just leaves the background showing; it must not fail the image.
			catch (err)
			{
				if (onError) onError(err);
			}
		}
	}
}

/**
 * Splits a track into journeys, newest first. A journey is a run of points no further apart in
 * time than the journey gap; lone points aren't a trip and are dropped.
 * @param {object[]} track
 * @param {number} gapMilliseconds
 * @returns {{ start: number, end: number, points: object[] }[]}
 */
function buildJourneys(track, gapMilliseconds)
{
	const points = (Array.isArray(track) ? track : [])
		.filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lon) && Number.isFinite(point.timestamp))
		.sort((first, second) => first.timestamp - second.timestamp);
	const journeys = [];

	points.forEach((point) =>
	{
		const current = journeys[journeys.length - 1];
		if (!current || point.timestamp - current.end > gapMilliseconds)
		{
			journeys.push({ start: point.timestamp, end: point.timestamp, points: [point] });
		} else
		{
			current.end = point.timestamp;
			current.points.push(point);
		}
	});

	return journeys
		.filter((journey) => journey.points.length > 1)
		.map((journey) => ({ ...journey, points: journey.points.slice(-MAX_JOURNEY_POINTS) }))
		.reverse();
}

function formatDistance(points, useMiles)
{
	let metres = 0;
	for (let index = 1; index < points.length; index++)
	{
		metres += distanceMeters(points[index - 1].lat, points[index - 1].lon, points[index].lat, points[index].lon);
	}

	const distance = useMiles ? (metres / 1000) * KM_TO_MILES : metres / 1000;
	return `${distance.toFixed(1)} ${useMiles ? 'mi' : 'km'}`;
}

function formatDuration(milliseconds)
{
	const minutes = Math.max(0, Math.round(milliseconds / 60000));
	return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

function pickZoom(points, width, height)
{
	const latitudes = points.map((point) => point.lat);
	const longitudes = points.map((point) => point.lon);
	const minLat = Math.min(...latitudes);
	const maxLat = Math.max(...latitudes);
	const minLon = Math.min(...longitudes);
	const maxLon = Math.max(...longitudes);
	const usableWidth = Math.max(1, width - (EDGE_PADDING * 2));
	const usableHeight = Math.max(1, height - (EDGE_PADDING * 2));

	for (let zoom = MAX_ZOOM; zoom > MIN_ZOOM; zoom--)
	{
		const spanX = lonToWorldX(maxLon, zoom) - lonToWorldX(minLon, zoom);
		const spanY = latToWorldY(minLat, zoom) - latToWorldY(maxLat, zoom);
		if (spanX <= usableWidth && spanY <= usableHeight)
		{
			return zoom;
		}
	}

	return MIN_ZOOM;
}

function drawLabel(canvas, text)
{
	if (!text)
	{
		return;
	}

	const size = measureText(text, LABEL_SCALE);
	canvas.fillRect(14, 14, size.width + 24, size.height + 20, COLOUR_BLACK, 0.55);
	drawText(canvas, text, 26, 24, LABEL_SCALE, COLOUR_WHITE);
}

function drawAttribution(canvas)
{
	const text = '© OpenStreetMap';
	const size = measureText(text, ATTRIBUTION_SCALE);
	canvas.fillRect(canvas.width - size.width - 14, canvas.height - size.height - 12, size.width + 14, size.height + 12, COLOUR_WHITE, 0.7);
	drawText(canvas, text, canvas.width - size.width - 7, canvas.height - size.height - 6, ATTRIBUTION_SCALE, [70, 70, 70]);
}

function drawMarker(canvas, x, y, colour)
{
	canvas.fillCircle(x, y, MARKER_RADIUS, COLOUR_WHITE);
	canvas.fillCircle(x, y, MARKER_RADIUS - 3, colour);
	canvas.fillCircle(x, y, MARKER_RADIUS - 11, COLOUR_WHITE);
}

/**
 * Draws everything that both image types share: tiles, the route (when there is more than one
 * point), an accuracy halo, the start/end markers, the label and the attribution.
 * @param {MapCanvas} canvas
 * @param {{ path: object[], accuracy?: number, label?: string, onError?: Function }} scene
 */
async function drawScene(canvas, scene)
{
	const { path } = scene;
	const zoom = path.length > 1 ? pickZoom(path, canvas.width, canvas.height) : SINGLE_POINT_ZOOM;
	const worldX = path.map((point) => lonToWorldX(point.lon, zoom));
	const worldY = path.map((point) => latToWorldY(point.lat, zoom));
	const originX = ((Math.min(...worldX) + Math.max(...worldX)) / 2) - (canvas.width / 2);
	const originY = ((Math.min(...worldY) + Math.max(...worldY)) / 2) - (canvas.height / 2);
	const projected = path.map((point, index) => ({ x: worldX[index] - originX, y: worldY[index] - originY }));
	const last = projected[projected.length - 1];

	await drawTiles(canvas, zoom, originX, originY, scene.onError);

	if (projected.length > 1)
	{
		canvas.drawPolyline(projected, 15, COLOUR_TRACK_HALO);
		canvas.drawPolyline(projected, 9, COLOUR_TRACK);
	}

	if (Number.isFinite(scene.accuracy) && scene.accuracy > 0)
	{
		// Web Mercator metres-per-pixel, corrected for latitude.
		const metresPerPixel = (156543.03392 * Math.cos((path[path.length - 1].lat * Math.PI) / 180)) / (2 ** zoom);
		const radius = scene.accuracy / metresPerPixel;
		if (radius > MARKER_RADIUS && radius < Math.max(canvas.width, canvas.height))
		{
			canvas.fillCircle(last.x, last.y, radius, COLOUR_ACCURACY, 0.15);
		}
	}

	if (projected.length > 1)
	{
		drawMarker(canvas, projected[0].x, projected[0].y, COLOUR_START);
	}
	drawMarker(canvas, last.x, last.y, COLOUR_CURRENT);

	drawLabel(canvas, scene.label);
	drawAttribution(canvas);
}

function createCanvas(options)
{
	return new MapCanvas(options.width || DEFAULT_WIDTH, options.height || DEFAULT_HEIGHT, COLOUR_BACKGROUND);
}

/**
 * Renders a PNG map for one user: the journey they are currently on when there is one, or just
 * their last known position. Tile failures degrade to a plain background rather than throwing.
 * @param {object} options
 * @param {{ lat: number, lon: number, accuracy?: number }|null} options.location Last known location.
 * @param {object[]} options.track Recorded track points.
 * @param {number} [options.journeyGapMinutes] Idle gap that ends a journey.
 * @param {string} [options.zone] Current zone, labelled when the user isn't moving.
 * @param {number} [options.speed] Current speed, labelled instead of the zone while travelling.
 * @param {boolean} [options.useMiles] Label the speed in mph rather than km/h.
 * @param {string} [options.placeholderText] Shown when there is no known position.
 * @param {(err: Error) => void} [options.onError]
 * @returns {Promise<Buffer>} PNG image data.
 */
async function renderUserMapImage(options)
{
	const canvas = createCanvas(options);
	const gapMilliseconds = (Number(options.journeyGapMinutes) || 30) * 60 * 1000;
	const journey = buildJourneys(options.track, gapMilliseconds)[0] || null;
	const newest = journey ? journey.points[journey.points.length - 1] : null;
	const reported = options.location && Number.isFinite(options.location.lat) && Number.isFinite(options.location.lon)
		? options.location
		: newest;

	if (!reported)
	{
		drawLabel(canvas, options.placeholderText || 'No location yet');
		drawAttribution(canvas);
		return canvas.toPngBuffer();
	}

	const current = { lat: reported.lat, lon: reported.lon };
	const inProgress = journey !== null && (Date.now() - journey.end) <= gapMilliseconds;
	const isNewPosition = !newest || newest.lat !== current.lat || newest.lon !== current.lon;
	const speed = Number(options.speed);

	await drawScene(canvas, {
		path: inProgress ? [...journey.points, ...(isNewPosition ? [current] : [])] : [current],
		accuracy: Number(reported.accuracy),
		label: Number.isFinite(speed) && speed > 0
			? `${Math.round(speed)} ${options.useMiles ? 'mph' : 'km/h'}`
			: options.zone,
		onError: options.onError,
	});

	return canvas.toPngBuffer();
}

/**
 * Renders one journey: its whole route with the start and end marked, labelled with the distance
 * covered and how long it took.
 * @param {object} options
 * @param {{ start: number, end: number, points: object[] }|undefined} options.journey
 * @param {boolean} [options.useMiles] Label the distance in miles rather than kilometres.
 * @param {string} [options.placeholderText] Shown when the journey no longer exists.
 * @param {(err: Error) => void} [options.onError]
 * @returns {Promise<Buffer>} PNG image data.
 */
async function renderJourneyMapImage(options)
{
	const canvas = createCanvas(options);
	const journey = options.journey;

	if (!journey || journey.points.length < 2)
	{
		drawLabel(canvas, options.placeholderText || 'No journey');
		drawAttribution(canvas);
		return canvas.toPngBuffer();
	}

	await drawScene(canvas, {
		path: journey.points,
		label: `${formatDistance(journey.points, Boolean(options.useMiles))} / ${formatDuration(journey.end - journey.start)}`,
		onError: options.onError,
	});

	return canvas.toPngBuffer();
}

module.exports = {
	renderUserMapImage: (options) => queueRender(() => renderUserMapImage(options)),
	renderJourneyMapImage: (options) => queueRender(() => renderJourneyMapImage(options)),
	buildJourneys,
	fetchTileBuffer,
	getTileStats,
	clearTileMemoryCache,
	clearTileCache,
	initializeTileCache,
};
