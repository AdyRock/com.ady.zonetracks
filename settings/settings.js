// The settings page runs in an iframe without clipboard-write permission, so
// the async Clipboard API is tried first but always falls back to execCommand.
function copyTextViaExecCommand(text)
{
	return new Promise((resolve, reject) =>
	{
		const textArea = document.createElement('textarea');
		textArea.value = text;
		textArea.style.position = 'fixed';
		textArea.style.opacity = '0';
		document.body.appendChild(textArea);
		textArea.focus();
		textArea.select();

		try
		{
			const succeeded = document.execCommand('copy');
			succeeded ? resolve() : reject(new Error('execCommand copy failed'));
		} catch (err)
		{
			reject(err);
		} finally
		{
			document.body.removeChild(textArea);
		}
	});
}

function copyText(text)
{
	if (navigator.clipboard && window.isSecureContext)
	{
		return navigator.clipboard.writeText(text).catch(() => copyTextViaExecCommand(text));
	}

	return copyTextViaExecCommand(text);
}

// Resizes/crops the image to a small square JPEG client-side, so the base64 payload
// stored on the device (and sent to OwnTracks as a "card" face) stays small.
function resizeImageToBase64(file, size)
{
	return new Promise((resolve, reject) =>
	{
		const reader = new FileReader();
		reader.onerror = () => reject(reader.error);
		reader.onload = () =>
		{
			const img = new Image();
			img.onerror = () => reject(new Error('Could not read image'));
			img.onload = () =>
			{
				const canvas = document.createElement('canvas');
				canvas.width = size;
				canvas.height = size;
				const ctx = canvas.getContext('2d');

				const scale = Math.max(size / img.width, size / img.height);
				const drawWidth = img.width * scale;
				const drawHeight = img.height * scale;
				ctx.drawImage(img, (size - drawWidth) / 2, (size - drawHeight) / 2, drawWidth, drawHeight);

				const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
				resolve(dataUrl.split(',')[1]);
			};
			img.src = reader.result;
		};
		reader.readAsDataURL(file);
	});
}

function onHomeyReady(Homey)
{
	document.getElementById('zoneName').placeholder = Homey.__('settings.zones.namePlaceholder');

	const tabNavShell = document.querySelector('.tab-nav-shell');
	const tabNav = document.querySelector('.tab-nav');
	const tabScrollLeft = document.querySelector('.tab-scroll-arrow-left');
	const tabScrollRight = document.querySelector('.tab-scroll-arrow-right');
	const tabButtons = document.querySelectorAll('.tab-nav-button');
	const tabPanels = {
		settings: document.getElementById('tabPanelSettings'),
		units: document.getElementById('tabPanelUnits'),
		avatars: document.getElementById('tabPanelAvatars'),
		zones: document.getElementById('tabPanelZones'),
		map: document.getElementById('tabPanelMap'),
		logs: document.getElementById('tabPanelLogs'),
	};

	function updateTabScrollArrows()
	{
		const maximumScroll = tabNav.scrollWidth - tabNav.clientWidth;
		tabNavShell.classList.toggle('can-scroll-left', tabNav.scrollLeft > 2);
		tabNavShell.classList.toggle('can-scroll-right', tabNav.scrollLeft < maximumScroll - 2);
	}

	function scrollTabs(direction)
	{
		tabNav.scrollBy({ left: direction * tabNav.clientWidth * 0.7, behavior: 'smooth' });
	}

	tabNav.addEventListener('scroll', updateTabScrollArrows, { passive: true });
	tabScrollLeft.addEventListener('click', () => scrollTabs(-1));
	tabScrollRight.addEventListener('click', () => scrollTabs(1));
	window.addEventListener('resize', updateTabScrollArrows);
	requestAnimationFrame(updateTabScrollArrows);

	function activateTab(button, remember)
	{
		tabButtons.forEach((other) => other.classList.toggle('active', other === button));
		Object.entries(tabPanels).forEach(([tab, panel]) =>
		{
			panel.classList.toggle('hidden', tab !== button.dataset.tab);
		});
		if (remember)
		{
			Homey.set('activeSettingsTab', button.dataset.tab, () => {});
		}
		if (button.dataset.tab === 'map')
		{
			// Keep the map hidden behind a "locating" placeholder rather than briefly showing the
			// London fallback centre while Homey's location is still being resolved.
			if (!trackMap) document.getElementById('trackMapLoading').classList.remove('hidden');
			getDefaultZoneCenter().then((center) =>
			{
				if (button.dataset.tab !== 'map' || tabPanels.map.classList.contains('hidden')) return;
				ensureTrackMap(center);
				document.getElementById('trackMapLoading').classList.add('hidden');
				setTimeout(() => trackMap.invalidateSize(), 100);
				loadTracks();
				loadTrackWaypoints();
			});
		}
		if (button.dataset.tab === 'logs')
		{
			loadLogs(40);
		}
	}

	tabButtons.forEach((button) =>
	{
		button.addEventListener('click', () => activateTab(button, true));
	});

	Homey.get('activeSettingsTab', (err, rememberedTab) =>
	{
		if (err) return;
		const rememberedTabButton = [...tabButtons].find((button) => button.dataset.tab === rememberedTab);
		if (rememberedTabButton)
		{
			setTimeout(() => activateTab(rememberedTabButton, false), 0);
		}
	});

	function wireHelpModal(buttonId, modalId, closeButtonId)
	{
		const modal = document.getElementById(modalId);
		document.getElementById(buttonId).addEventListener('click', () => modal.classList.remove('hidden'));
		document.getElementById(closeButtonId).addEventListener('click', () => modal.classList.add('hidden'));
	}

	function appendHelpText(element, text)
	{
		let offset = 0;
		const markerPattern = /\*\*([^*]+)\*\*/g;
		for (const match of text.matchAll(markerPattern))
		{
			if (match.index > offset) element.appendChild(document.createTextNode(text.slice(offset, match.index)));
			const emphasized = document.createElement('strong');
			emphasized.className = 'help-field-name';
			emphasized.textContent = match[1];
			element.appendChild(emphasized);
			offset = match.index + match[0].length;
		}
		if (offset < text.length) element.appendChild(document.createTextNode(text.slice(offset)));
	}

	function renderHelpBody(element, text)
	{
		element.textContent = '';
		text.split('\n\n').forEach((section, index) =>
		{
			if (index) element.appendChild(document.createTextNode('\n\n'));
			const headingBreak = section.indexOf('\n');
			if (headingBreak < 0)
			{
				appendHelpText(element, section);
				return;
			}
			const heading = document.createElement('strong');
			heading.className = 'help-section-heading';
			heading.textContent = section.slice(0, headingBreak);
			element.append(heading, document.createElement('br'));
			appendHelpText(element, section.slice(headingBreak + 1));
		});
	}

	wireHelpModal('helpMqtt', 'helpModalMqtt', 'closeHelpMqtt');
	wireHelpModal('helpHttp', 'helpModalHttp', 'closeHelpHttp');
	document.getElementById('helpMethodComparison').appendChild(document.querySelector('#helpMqtt svg').cloneNode(true));
	wireHelpModal('helpMethodComparison', 'helpModalMethodComparison', 'closeHelpMethodComparison');
	const helpSettings = document.getElementById('helpSettings');
	const helpSettingsLabel = Homey.__('settings.help.settings.aria');
	helpSettings.setAttribute('aria-label', helpSettingsLabel);
	helpSettings.setAttribute('title', helpSettingsLabel);
	helpSettings.appendChild(document.querySelector('#helpMqtt svg').cloneNode(true));
	wireHelpModal('helpSettings', 'helpModalSettings', 'closeHelpSettings');
	const helpMap = document.getElementById('helpMap');
	const helpMapLabel = Homey.__('settings.map.contextHelpAria');
	helpMap.setAttribute('aria-label', helpMapLabel);
	helpMap.setAttribute('title', helpMapLabel);
	helpMap.appendChild(document.querySelector('#helpMqtt svg').cloneNode(true));
	wireHelpModal('helpMap', 'helpModalMap', 'closeHelpMap');
	const helpZones = document.getElementById('helpZones');
	const helpZonesLabel = Homey.__('settings.zones.helpAria');
	helpZones.setAttribute('aria-label', helpZonesLabel);
	helpZones.setAttribute('title', helpZonesLabel);
	helpZones.appendChild(document.querySelector('#helpMqtt svg').cloneNode(true));
	document.querySelectorAll('.modal-overlay .help-body').forEach((body) => renderHelpBody(body, body.textContent));
	wireHelpModal('helpZones', 'helpModalZones', 'closeHelpZones');
	const helpJourneys = document.getElementById('helpJourneys');
	helpJourneys.appendChild(document.querySelector('#helpMqtt svg').cloneNode(true));
	wireHelpModal('helpJourneys', 'helpModalJourneys', 'closeHelpJourneys');

	function updateMapFilterHelp(journeysDisplayed)
	{
		const keyPrefix = journeysDisplayed ? 'journeyHelp' : 'filterHelp';
		const label = Homey.__(`settings.map.${keyPrefix}Aria`);
		helpJourneys.setAttribute('aria-label', label);
		helpJourneys.setAttribute('title', label);
		document.getElementById('mapFilterHelpTitle').textContent = Homey.__(`settings.map.${keyPrefix}Title`);
		renderHelpBody(document.getElementById('mapFilterHelpBody'), Homey.__(`settings.map.${keyPrefix}Body`));
		const backHelp = document.getElementById('mapFilterHelpBack');
		backHelp.classList.toggle('hidden', !journeysDisplayed);
		backHelp.textContent = journeysDisplayed ? Homey.__('settings.map.journeyHelpBack') : '';
	}

	updateMapFilterHelp(false);

	const methodMqtt = document.getElementById('methodMqtt');
	const methodHttp = document.getElementById('methodHttp');
	const mqttFields = document.getElementById('mqttFields');
	const mqttBrokerUrl = document.getElementById('mqttBrokerUrl');
	const mqttUseTls = document.getElementById('mqttUseTls');
	const mqttTlsSection = document.getElementById('mqttTlsSection');
	const mqttTlsToggle = document.getElementById('mqttTlsToggle');
	const mqttTlsOptions = document.getElementById('mqttTlsOptions');
	const mqttCaCert = document.getElementById('mqttCaCert');
	const mqttCaCertFile = document.getElementById('mqttCaCertFile');
	const mqttCaCertClear = document.getElementById('mqttCaCertClear');
	const mqttAllowSelfSigned = document.getElementById('mqttAllowSelfSigned');
	const mqttPort = document.getElementById('mqttPort');
	const mqttUsername = document.getElementById('mqttUsername');
	const mqttPassword = document.getElementById('mqttPassword');
	const toggleMqttPassword = document.getElementById('toggleMqttPassword');
	const saveButton = document.getElementById('save');
	const speedUnitKmh = document.getElementById('speedUnitKmh');
	const speedUnitMph = document.getElementById('speedUnitMph');
	let mapSpeedUnit = 'kmh';

	function updatePasswordToggle(passwordVisible)
	{
		const translationKey = passwordVisible ? 'hidePassword' : 'showPassword';
		const label = Homey.__(`settings.mqtt.${translationKey}`);
		mqttPassword.type = passwordVisible ? 'text' : 'password';
		toggleMqttPassword.setAttribute('aria-label', label);
		toggleMqttPassword.setAttribute('title', label);
		toggleMqttPassword.setAttribute('aria-pressed', String(passwordVisible));
		toggleMqttPassword.querySelector('.password-show-icon').classList.toggle('hidden', passwordVisible);
		toggleMqttPassword.querySelector('.password-hide-icon').classList.toggle('hidden', !passwordVisible);
	}

	toggleMqttPassword.addEventListener('click', () =>
	{
		updatePasswordToggle(mqttPassword.type === 'password');
	});
	updatePasswordToggle(false);

	function updateVisibility()
	{
		mqttFields.classList.toggle('hidden', !methodMqtt.checked);
		mqttTlsSection.classList.toggle('hidden', !mqttUseTls.checked);
	}

	function setTlsOptionsExpanded(expanded)
	{
		mqttTlsToggle.setAttribute('aria-expanded', String(expanded));
		mqttTlsOptions.classList.toggle('hidden', !expanded);
	}

	methodMqtt.addEventListener('change', updateVisibility);
	methodHttp.addEventListener('change', updateVisibility);

	mqttTlsToggle.addEventListener('click', () =>
	{
		setTlsOptionsExpanded(mqttTlsToggle.getAttribute('aria-expanded') !== 'true');
	});

	mqttUseTls.addEventListener('change', () =>
	{
		mqttPort.value = mqttUseTls.checked ? 8883 : 1883;
		updateVisibility();
	});

	mqttCaCertFile.addEventListener('change', () =>
	{
		const file = mqttCaCertFile.files[0];
		if (!file) return;

		const reader = new FileReader();
		reader.onerror = () => Homey.alert(Homey.__('settings.mqtt.caCertReadFailed'));
		reader.onload = () =>
		{
			const pem = String(reader.result).trim();
			// A DER (binary) .crt has no PEM header and can't be pasted into a text setting.
			if (!pem.includes('-----BEGIN CERTIFICATE-----'))
			{
				Homey.alert(Homey.__('settings.mqtt.caCertInvalid'));
				return;
			}
			mqttCaCert.value = pem;
		};
		reader.readAsText(file);
		mqttCaCertFile.value = '';
	});

	mqttCaCertClear.addEventListener('click', () =>
	{
		mqttCaCert.value = '';
	});

	Homey.get('connectionMethod', (err, value) =>
	{
		if (err) return Homey.alert(err);
		if (value === 'mqtt')
		{
			methodMqtt.checked = true;
		} else
		{
			methodHttp.checked = true;
		}
		updateVisibility();
	});

	Homey.get('mqttBrokerUrl', (err, value) => { if (!err && value) mqttBrokerUrl.value = value; });
	Homey.get('mqttUseTls', (err, value) => { if (!err) mqttUseTls.checked = Boolean(value); updateVisibility(); });
	Homey.get('mqttCaCert', (err, value) =>
	{
		if (err || !value) return;
		mqttCaCert.value = value;
		setTlsOptionsExpanded(true);
	});
	Homey.get('mqttAllowSelfSigned', (err, value) =>
	{
		if (err || !value) return;
		mqttAllowSelfSigned.checked = true;
		setTlsOptionsExpanded(true);
	});
	Homey.get('mqttPort', (err, value) => { if (!err && value) mqttPort.value = value; });
	Homey.get('mqttUsername', (err, value) => { if (!err && value) mqttUsername.value = value; });
	Homey.get('mqttPassword', (err, value) => { if (!err && value) mqttPassword.value = value; });
	const trackMinDistanceInput = document.getElementById('trackMinDistance');
	const trackMaxPointsInput = document.getElementById('trackMaxPoints');
	let trackMinDistance = 50;
	let trackMaxPoints = 1000;

	Homey.get('speedUnit', (err, value) =>
	{
		if (err) return Homey.alert(err);
		mapSpeedUnit = value === 'mph' ? 'mph' : 'kmh';
		(mapSpeedUnit === 'mph' ? speedUnitMph : speedUnitKmh).checked = true;
		if (trackMap) updateTrackScale();
	});

	Homey.get('trackMinDistance', (err, value) => {
		if (!err && value) {
			trackMinDistance = Number(value);
			trackMinDistanceInput.value = trackMinDistance;
		}
	});

	Homey.get('trackMaxPoints', (err, value) => {
		if (!err && value) {
			trackMaxPoints = Number(value);
			trackMaxPointsInput.value = trackMaxPoints;
		}
	});

	[speedUnitKmh, speedUnitMph].forEach((radio) =>
	{
		radio.addEventListener('change', () =>
		{
			if (radio.checked)
			{
				mapSpeedUnit = radio.value;
				if (trackMap)
				{
					updateTrackScale();
					renderJourneys();
					renderTracks(trackUsers, true);
					renderTrackHistory(trackUsers);
				}
				Homey.set('speedUnit', radio.value, (err) => { if (err) Homey.alert(err); });
			}
		});
	});

	trackMinDistanceInput.addEventListener('change', () => {
		trackMinDistance = Math.min(500, Math.max(10, Math.round(Number(trackMinDistanceInput.value) || 50)));
		trackMinDistanceInput.value = trackMinDistance;
		Homey.set('trackMinDistance', trackMinDistance, (err) => { if (err) Homey.alert(err); });
	});

	trackMaxPointsInput.addEventListener('change', () => {
		trackMaxPoints = Math.min(5000, Math.max(100, Math.round(Number(trackMaxPointsInput.value) || 1000)));
		trackMaxPointsInput.value = trackMaxPoints;
		Homey.set('trackMaxPoints', trackMaxPoints, (err) => { if (err) Homey.alert(err); });
	});

	document.getElementById('backupSettings').addEventListener('click', () =>
	{
		Homey.api('GET', '/settings/backup', null, (err, backup) =>
		{
			if (err) return Homey.alert(err);
			copyText(JSON.stringify(backup)).then(() => Homey.alert(Homey.__('settings.backup.copied')))
				.catch(() => Homey.alert(Homey.__('settings.backup.copyFailed')));
		});
	});

	const settingsBackupInput = document.getElementById('settingsBackupInput');

	function restoreSettingsBackup(text)
	{
		let backup;
		try
		{
			backup = JSON.parse(text);
		} catch (err)
		{
			Homey.alert(Homey.__('settings.backup.invalid'));
			return;
		}
		Homey.confirm(Homey.__('settings.backup.restoreConfirm'), null, (confirmErr, confirmed) =>
		{
			if (confirmErr || !confirmed) return;
			Homey.api('POST', '/settings/restore', backup, (err, result) =>
			{
				if (err) return Homey.alert(err);
				loadAvatarList();
				loadZoneList();
				Homey.alert(Homey.__('settings.backup.restored'), null, () => window.location.reload());
			});
		});
	}

	document.getElementById('restoreSettings').addEventListener('click', () =>
	{
		const pastedBackup = settingsBackupInput.value.trim();
		if (pastedBackup)
		{
			restoreSettingsBackup(pastedBackup);
			return;
		}
		Homey.alert(Homey.__('settings.backup.pasteRequired'), null, () => settingsBackupInput.focus());
	});

	function translateStatus(key, status)
	{
		return Homey.__(`settings.status.${key}`)
			.replaceAll('[[method]]', String(status.method || '?'))
			.replaceAll('[[error]]', String(status.error || ''));
	}

	function renderConnectionStatus(status)
	{
		const el = document.getElementById('connectionStatus');
		if (!status)
		{
			el.textContent = Homey.__('settings.status.unknown');
			el.className = 'connection-status';
			return;
		}

		if (status.connecting)
		{
			el.textContent = translateStatus('connecting', status);
			el.className = 'connection-status';
		} else if (status.connected)
		{
			el.textContent = translateStatus('connected', status);
			el.className = 'connection-status connected';
		} else
		{
			el.textContent = status.error
				? translateStatus('notConnectedWithError', status)
				: translateStatus('notConnected', status);
			el.className = 'connection-status error';
		}
	}

	// Right after an app (re)install/restart, Homey's own API gateway can take up to
	// ~30s to recognize newly registered routes - retry for up to ~60s instead of
	// flashing a confusing transient "endpoint not found" style error.
	function fetchConnectionStatus(attemptsLeft)
	{
		Homey.api('GET', '/connection-status', null, (err, status) =>
		{
			if (err)
			{
				if (attemptsLeft > 0)
				{
					setTimeout(() => fetchConnectionStatus(attemptsLeft - 1), 1500);
					return;
				}
				renderConnectionStatus({ connected: false, connecting: false, method: '?', error: String(err.message || err) });
				return;
			}
			renderConnectionStatus(status);
		});
	}

	fetchConnectionStatus(40);

	// The app pushes this event whenever the connector (re)connects, disconnects, or errors.
	Homey.on('connection_status_changed', (status) => renderConnectionStatus(status));

	function renderLogs(text)
	{
		const logsView = document.getElementById('logsView');
		logsView.textContent = text || Homey.__('settings.logs.noMessages');
		logsView.scrollTop = logsView.scrollHeight;
	}

	let logsLoadGeneration = 0;
	function loadLogs(attemptsLeft, generation = ++logsLoadGeneration)
	{
		Homey.api('GET', '/logs', null, (err, result) =>
		{
			if (generation !== logsLoadGeneration) return;
			if (err || !result || typeof result.text !== 'string')
			{
				if (attemptsLeft > 0)
				{
					setTimeout(() => loadLogs(attemptsLeft - 1, generation), 1500);
					return;
				}
				renderLogs(String(err && (err.message || err) || Homey.__('settings.logs.noMessages')));
				return;
			}
			renderLogs(result.text);
		});
	}

	loadLogs(40);

	// The app pushes this event whenever a new message is logged.
	Homey.on('log_updated', (text) => renderLogs(text));

	const logsEnabled = document.getElementById('logsEnabled');
	Homey.get('logsEnabled', (err, value) => { if (!err) logsEnabled.checked = Boolean(value); });
	Homey.on('logs_enabled_changed', (value) => { logsEnabled.checked = Boolean(value); });
	logsEnabled.addEventListener('change', () =>
	{
		Homey.set('logsEnabled', logsEnabled.checked, (err) => { if (err) Homey.alert(err); });
	});

	document.getElementById('clearLogs').addEventListener('click', () =>
	{
		Homey.api('DELETE', '/logs', null, (err) => { if (err) Homey.alert(err); });
	});

	document.getElementById('copyLogs').addEventListener('click', (event) =>
	{
		const button = event.currentTarget;
		const text = document.getElementById('logsView').textContent;

		copyText(text).then(() =>
		{
			const originalText = button.textContent;
			button.textContent = Homey.__('settings.logs.copied');
			setTimeout(() => { button.textContent = originalText; }, 2000);
		}).catch(() => Homey.alert(Homey.__('settings.logs.copyFailed')));
	});

	document.getElementById('emailLogs').addEventListener('click', (event) =>
	{
		const button = event.currentTarget;
		button.disabled = true;
		button.textContent = Homey.__('settings.logs.emailSending');

		Homey.api('POST', '/logs/email', null, (err) =>
		{
			button.disabled = false;
			button.textContent = Homey.__('settings.logs.email');
			if (err) return Homey.alert(err);
			Homey.alert(Homey.__('settings.logs.emailSent'));
		});
	});

	function loadAvatarList()
	{
		const avatarList = document.getElementById('avatarList');

		Homey.api('GET', '/users', null, (err, users) =>
		{
			if (err || !Array.isArray(users)) return;

			avatarList.innerHTML = '';

			if (!users.length)
			{
				avatarList.textContent = Homey.__('settings.avatars.noUsers');
				return;
			}

			users.forEach((user) =>
			{
				const row = document.createElement('div');
				row.className = 'avatar-row';

				const preview = document.createElement('img');
				preview.className = 'avatar-preview';
				preview.alt = user.name;
				if (user.avatarBase64) preview.src = 'data:image/jpeg;base64,' + user.avatarBase64;
				row.appendChild(preview);

				const name = document.createElement('span');
				name.className = 'avatar-name';
				name.textContent = user.name + (user.hasAvatar ? '' : Homey.__('settings.avatars.noAvatarYet'));
				row.appendChild(name);

				const fileInput = document.createElement('input');
				fileInput.type = 'file';
				fileInput.accept = 'image/*';
				fileInput.className = 'avatar-file-input';
				fileInput.id = 'avatarFile_' + user.id;
				fileInput.addEventListener('change', () =>
				{
					const file = fileInput.files[0];
					if (!file) return;

					resizeImageToBase64(file, 128).then((base64) =>
					{
						preview.src = 'data:image/jpeg;base64,' + base64;

						Homey.api('POST', '/avatar', { userId: user.id, imageBase64: base64 }, (uploadErr) =>
						{
							if (uploadErr) return Homey.alert(uploadErr);
							name.textContent = user.name;
						});
					}).catch((resizeErr) => Homey.alert(resizeErr));
				});
				row.appendChild(fileInput);

				const fileLabel = document.createElement('label');
				fileLabel.className = 'homey-button-secondary-shadow-small';
				fileLabel.setAttribute('for', fileInput.id);
				fileLabel.textContent = Homey.__('settings.avatars.chooseFile');
				row.appendChild(fileLabel);

				avatarList.appendChild(row);
			});
		});
	}

	loadAvatarList();

	let zoneConfiguration = { shared: [], users: [] };
	let activeZoneUserId = null;
	const expandedSharedZoneUserIds = new Set();

	function createZoneSection(title, toggleOptions)
	{
		const heading = document.createElement('h3');
		heading.className = 'zone-section-title';
		if (!toggleOptions)
		{
			heading.textContent = title;
			return heading;
		}

		const button = document.createElement('button');
		button.type = 'button';
		button.className = 'zone-section-toggle';
		button.setAttribute('aria-expanded', String(toggleOptions.expanded));
		const label = document.createElement('span');
		label.textContent = title;
		const arrow = document.createElement('span');
		arrow.className = 'zone-section-toggle-arrow';
		arrow.setAttribute('aria-hidden', 'true');
		button.append(label, arrow);
		button.addEventListener('click', toggleOptions.onToggle);
		heading.appendChild(button);
		return heading;
	}

	function createZoneRow(waypoint, options)
	{
		const row = document.createElement('div');
		row.className = 'zone-row';

		if (options.readOnly)
		{
			const enabled = document.createElement('input');
			enabled.type = 'checkbox';
			enabled.className = 'zone-enabled';
			enabled.checked = waypoint.enabled;
			enabled.setAttribute('aria-label', Homey.__('settings.zones.enabledAria'));
			enabled.addEventListener('change', () => Homey.api('POST', '/waypoints/shared-enabled', {
				userId: options.userId,
				waypointId: waypoint.id,
				enabled: enabled.checked,
			}, (err) => { if (err) Homey.alert(err); }));
			row.appendChild(enabled);
		}

		const info = document.createElement('div');
		info.className = 'zone-info';
		const name = document.createElement('div');
		name.className = 'zone-name';
		name.textContent = waypoint.desc;
		info.appendChild(name);
		const details = document.createElement('div');
		details.className = 'zone-details';
		details.textContent = `${waypoint.lat}, ${waypoint.lon} - ${waypoint.rad}m`;
		info.appendChild(details);
		row.appendChild(info);

		if (!options.readOnly)
		{
			if (options.scope === 'private')
			{
				const shareButton = document.createElement('button');
				shareButton.type = 'button';
				shareButton.className = 'zone-share-button';
				shareButton.setAttribute('aria-label', Homey.__('settings.zones.moveToSharedAria'));
				shareButton.setAttribute('title', Homey.__('settings.zones.moveToSharedAria'));
				shareButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5 20h14v-2H5v2zm7-18L5.3 8.7l1.4 1.4L11 5.8V16h2V5.8l4.3 4.3 1.4-1.4L12 2z"/></svg>';
				shareButton.addEventListener('click', () => Homey.api('POST', '/waypoints/move-to-shared', {
					userId: options.userId,
					waypointId: waypoint.id,
				}, (err) =>
				{
					if (err) return Homey.alert(err);
					loadZoneList();
				}));
				row.appendChild(shareButton);

				const copyButton = document.createElement('button');
				copyButton.type = 'button';
				copyButton.className = 'zone-copy-button';
				copyButton.setAttribute('aria-label', Homey.__('settings.zones.copyAria'));
				copyButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';
				copyButton.addEventListener('click', () => openCopyZone(waypoint, options.userId));
				row.appendChild(copyButton);
			}

			const editButton = document.createElement('button');
			editButton.type = 'button';
			editButton.className = 'zone-edit-button';
			editButton.setAttribute('aria-label', Homey.__('settings.zones.editAria'));
			editButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.03 0-1.42l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.82z"/></svg>';
			editButton.addEventListener('click', () => openZoneEditor(waypoint, options));
			row.appendChild(editButton);

			const deleteButton = document.createElement('button');
			deleteButton.type = 'button';
			deleteButton.className = 'zone-delete-button';
			deleteButton.setAttribute('aria-label', Homey.__('settings.zones.deleteAria'));
			deleteButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 3a1 1 0 0 0-1 1v1H4v2h16V5h-4V4a1 1 0 0 0-1-1H9zM5 8l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12H5zm4 3h2v8H9v-8zm4 0h2v8h-2v-8z"/></svg>';
			deleteButton.addEventListener('click', () => Homey.api('POST', '/waypoints/delete', {
				id: waypoint.id,
				scope: options.scope,
				userId: options.userId,
			}, (err) => { if (err) Homey.alert(err); }));
			row.appendChild(deleteButton);
		}

		return row;
	}

	function renderZoneConfiguration()
	{
		const zoneTabs = document.getElementById('zoneTabs');
		const zoneList = document.getElementById('zoneList');
		zoneTabs.textContent = '';
		zoneList.textContent = '';
		const tabs = [{ id: null, name: Homey.__('settings.zones.shared') }, ...zoneConfiguration.users];
		if (activeZoneUserId && !zoneConfiguration.users.some((user) => user.id === activeZoneUserId)) activeZoneUserId = null;

		tabs.forEach((tab) =>
		{
			const button = document.createElement('button');
			button.type = 'button';
			button.className = `homey-button-secondary-shadow-small${tab.id === activeZoneUserId ? ' active' : ''}`;
			button.textContent = tab.name;
			button.addEventListener('click', () => { activeZoneUserId = tab.id; renderZoneConfiguration(); });
			zoneTabs.appendChild(button);
		});

		const activeUser = zoneConfiguration.users.find((user) => user.id === activeZoneUserId);
		document.getElementById('zoneIntro').textContent = Homey.__(activeUser
			? 'settings.zones.introUser'
			: 'settings.zones.introShared');
		if (!activeUser)
		{
			zoneConfiguration.shared.forEach((waypoint) => zoneList.appendChild(createZoneRow(waypoint, { scope: 'shared' })));
			if (!zoneConfiguration.shared.length) zoneList.textContent = Homey.__('settings.zones.noZonesYet');
		} else
		{
			const sharedExpanded = expandedSharedZoneUserIds.has(activeUser.id);
			zoneList.appendChild(createZoneSection(Homey.__('settings.zones.shared'), {
				expanded: sharedExpanded,
				onToggle: () =>
				{
					if (sharedExpanded) expandedSharedZoneUserIds.delete(activeUser.id);
					else expandedSharedZoneUserIds.add(activeUser.id);
					renderZoneConfiguration();
				},
			}));
			if (sharedExpanded)
			{
				activeUser.shared.forEach((waypoint) => zoneList.appendChild(createZoneRow(waypoint, { readOnly: true, userId: activeUser.id })));
				if (!activeUser.shared.length) zoneList.appendChild(document.createTextNode(Homey.__('settings.zones.noSharedZones')));
			}
			zoneList.appendChild(createZoneSection(Homey.__('settings.zones.private')));
			activeUser.private.forEach((waypoint) => zoneList.appendChild(createZoneRow(waypoint, { scope: 'private', userId: activeUser.id })));
			if (!activeUser.private.length) zoneList.appendChild(document.createTextNode(Homey.__('settings.zones.noPrivateZones')));
		}
		document.getElementById('openAddZone').textContent = Homey.__(activeZoneUserId ? 'settings.zones.addPrivateZone' : 'settings.zones.addSharedZone');
	}

	function loadZoneList()
	{
		Homey.api('GET', '/waypoints/configuration', null, (err, configuration) =>
		{
			if (err || !configuration) return;
			zoneConfiguration = configuration;
			renderZoneConfiguration();
		});
	}

	loadZoneList();
	Homey.on('waypoint_configuration_updated', loadZoneList);

	const addZoneModal = document.getElementById('addZoneModal');
	const zoneLatInput = document.getElementById('zoneLat');
	const zoneLonInput = document.getElementById('zoneLon');
	const zoneRadiusInput = document.getElementById('zoneRadius');
	const zoneNameInput = document.getElementById('zoneName');
	const zoneModalTitle = document.querySelector('#addZoneModal h2');
	const saveZoneButton = document.getElementById('addZone');
	let editingZone = null;

	let zoneMap = null;
	let zoneMarker = null;
	let zoneCircle = null;
	let defaultZoneCenter = null;
	const FALLBACK_ZONE_CENTER = [51.5074, -0.1278];

	function fetchBrowserLocation()
	{
		return new Promise((resolve) =>
		{
			if (!navigator.geolocation || !window.isSecureContext)
			{
				resolve(null);
				return;
			}

			navigator.geolocation.getCurrentPosition(
				(position) => resolve([position.coords.latitude, position.coords.longitude]),
				() => resolve(null),
				// The map now waits behind a "locating" placeholder instead of flashing the London
				// fallback, so it's worth giving a slow/prompted geolocation answer more time.
				{ timeout: 15000, maximumAge: 300000 },
			);
		});
	}

	function fetchDefaultLocation()
	{
		return new Promise((resolve) =>
		{
			Homey.api('GET', '/default-location', (err, location) =>
			{
				if (err || !location || typeof location.lat !== 'number' || typeof location.lon !== 'number')
				{
					resolve(null);
					return;
				}

				resolve([location.lat, location.lon]);
			});
		});
	}

	// A new zone starts wherever the user is; the most recently reported user position (or
	// Homey's own configured location) is the fallback when the browser won't share a location,
	// and only then a fixed view.
	function getDefaultZoneCenter()
	{
		if (defaultZoneCenter) return Promise.resolve(defaultZoneCenter);

		return fetchBrowserLocation()
			.then((browserLocation) => browserLocation || fetchDefaultLocation())
			.then((location) =>
			{
				defaultZoneCenter = location || FALLBACK_ZONE_CENTER;
				return defaultZoneCenter;
			});
	}

	function createOsmTileLayer()
	{
		const SettingsTileLayer = L.GridLayer.extend({
			createTile(coords, done)
			{
				const tile = document.createElement('img');
				tile.alt = '';
				tile.setAttribute('role', 'presentation');
				Homey.api('GET', `/map-tiles/${coords.z}/${coords.x}/${coords.y}`, null, (err, result) =>
				{
					if (err || !result || !result.data)
					{
						done(err || new Error('Map tile could not be loaded'), tile);
						return;
					}

					tile.onload = () => done(null, tile);
					tile.onerror = () => done(new Error('Map tile could not be displayed'), tile);
					tile.src = `data:image/png;base64,${result.data}`;
				});
				return tile;
			},
		});

		return new SettingsTileLayer({
			attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors',
			maxZoom: 19,
		});
	}

	function placeZoneMarker(lat, lon)
	{
		const radius = Number(zoneRadiusInput.value) || 100;

		if (zoneMarker)
		{
			zoneMarker.setLatLng([lat, lon]);
			zoneCircle.setLatLng([lat, lon]).setRadius(radius);
		} else
		{
			zoneMarker = L.marker([lat, lon]).addTo(zoneMap);
			zoneCircle = L.circle([lat, lon], { radius }).addTo(zoneMap);
		}
	}

	function ensureZoneMap()
	{
		if (zoneMap) return;

		zoneMap = L.map('zoneMap').setView(defaultZoneCenter || FALLBACK_ZONE_CENTER, 13);
		createOsmTileLayer().addTo(zoneMap);

		zoneMap.on('click', (e) =>
		{
			zoneLatInput.value = e.latlng.lat.toFixed(6);
			zoneLonInput.value = e.latlng.lng.toFixed(6);
			placeZoneMarker(e.latlng.lat, e.latlng.lng);
		});
	}

	zoneRadiusInput.addEventListener('input', () =>
	{
		if (zoneCircle)
		{
			zoneCircle.setRadius(Number(zoneRadiusInput.value) || 100);
		}
	});

	document.getElementById('openAddZone').addEventListener('click', () =>
	{
		editingZone = null;
		zoneModalTitle.textContent = Homey.__('settings.zones.modalTitle');
		saveZoneButton.textContent = Homey.__('settings.zones.addZone');
		zoneNameInput.value = '';
		zoneLatInput.value = '';
		zoneLonInput.value = '';
		zoneRadiusInput.value = '';
		if (zoneMarker)
		{
			zoneMap.removeLayer(zoneMarker);
			zoneMap.removeLayer(zoneCircle);
			zoneMarker = null;
			zoneCircle = null;
		}
		addZoneModal.classList.remove('hidden');
		ensureZoneMap();
		getDefaultZoneCenter().then((center) =>
		{
			// The user may have picked a spot (or closed the dialog) while the location resolved.
			if (zoneMarker || addZoneModal.classList.contains('hidden')) return;
			zoneMap.setView(center, 15);
		});
		// The map was hidden (display: none) when created, so it needs a resize nudge.
		setTimeout(() => zoneMap.invalidateSize(), 100);
	});

	function openZoneEditor(waypoint, options)
	{
		editingZone = { id: waypoint.id, scope: options.scope, userId: options.userId || null };
		zoneModalTitle.textContent = Homey.__('settings.zones.editModalTitle');
		saveZoneButton.textContent = Homey.__('settings.zones.updateZone');
		zoneNameInput.value = waypoint.desc || '';
		zoneLatInput.value = waypoint.lat ?? '';
		zoneLonInput.value = waypoint.lon ?? '';
		zoneRadiusInput.value = waypoint.rad ?? '';
		addZoneModal.classList.remove('hidden');
		ensureZoneMap();
		zoneMap.setView([Number(waypoint.lat), Number(waypoint.lon)], 15);
		placeZoneMarker(Number(waypoint.lat), Number(waypoint.lon));
		setTimeout(() => zoneMap.invalidateSize(), 100);
	}

	const copyZoneModal = document.getElementById('copyZoneModal');
	let copiedZone = null;

	function openCopyZone(waypoint, sourceUserId)
	{
		copiedZone = { waypointId: waypoint.id, sourceUserId };
		const users = document.getElementById('copyZoneUsers');
		users.textContent = '';
		zoneConfiguration.users.filter((user) => user.id !== sourceUserId).forEach((user) =>
		{
			const label = document.createElement('label');
			label.className = 'homey-form-checkbox';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.className = 'homey-form-checkbox-input copy-zone-user';
			checkbox.value = user.id;
			label.appendChild(checkbox);
			const checkmark = document.createElement('span');
			checkmark.className = 'homey-form-checkbox-checkmark';
			label.appendChild(checkmark);
			const text = document.createElement('span');
			text.className = 'homey-form-checkbox-text';
			text.textContent = user.name;
			label.appendChild(text);
			users.appendChild(label);
		});
		copyZoneModal.classList.remove('hidden');
	}

	document.getElementById('cancelCopyZone').addEventListener('click', () =>
	{
		copiedZone = null;
		copyZoneModal.classList.add('hidden');
	});

	document.getElementById('copyZone').addEventListener('click', () =>
	{
		const destinationUserIds = [...document.querySelectorAll('.copy-zone-user:checked')].map((checkbox) => checkbox.value);
		if (!copiedZone || !destinationUserIds.length)
		{
			Homey.alert(Homey.__('settings.zones.selectCopyUser'));
			return;
		}
		const conflict = document.querySelector('input[name="copyConflict"]:checked').value;
		Homey.api('POST', '/waypoints/copy', { ...copiedZone, destinationUserIds, conflict }, (err) =>
		{
			if (err) return Homey.alert(err);
			copiedZone = null;
			copyZoneModal.classList.add('hidden');
		});
	});

	// --- Map tab: live positions and track history for every user ---
	let trackMap = null;
	let trackScaleControl = null;
	const trackLayers = []; // markers + polylines, cleared and redrawn on every refresh
	const trackPointLayers = [];

	// Bearing in degrees (0 = north, clockwise) from one point to the next, used to
	// orient the direction-of-travel arrows drawn along each track segment.
	function computeBearing(lat1, lon1, lat2, lon2)
	{
		const toRad = (deg) => deg * Math.PI / 180;
		const toDeg = (rad) => rad * 180 / Math.PI;
		const dLon = toRad(lon2 - lon1);
		const y = Math.sin(dLon) * Math.cos(toRad(lat2));
		const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
		return (toDeg(Math.atan2(y, x)) + 360) % 360;
	}
	let trackPointMarkers = new WeakMap();
	let trackHistoryRows = new WeakMap();
	// Panning or zooming suspends the automatic re-centring done by background refreshes,
	// until the user centres on a user again.
	let trackViewportPinned = false;
	let lastProgrammaticTrackViewAt = 0;
	const trackZoneLayers = [];
	const TRACK_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c'];
	const CHEQUERED_FLAG_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true">'
		+ '<rect x="5" y="2" width="15" height="10" fill="#fff" stroke="#1a1a1a" stroke-width="1"/>'
		+ '<g fill="#1a1a1a"><rect x="5" y="2" width="5" height="5"/><rect x="15" y="2" width="5" height="5"/>'
		+ '<rect x="10" y="7" width="5" height="5"/></g>'
		+ '<rect x="3" y="2" width="2" height="20" fill="#1a1a1a"/></svg>';
	// Zone circles shrink to nothing when zoomed out, so every zone also gets a
	// fixed-size pin whose point sits on the zone centre.
	const ZONE_PIN_SVG = '<svg viewBox="0 0 24 32" aria-hidden="true">'
		+ '<line x1="12" y1="9" x2="12" y2="31" stroke="#4a4a4a" stroke-width="2"/>'
		+ '<circle cx="12" cy="9" r="8" fill="#999" stroke="#4a4a4a" stroke-width="2"/>'
		+ '<circle cx="12" cy="9" r="3" fill="#fff"/></svg>';
	let trackUsers = [];
	let trackWaypoints = [];
	let selectedTrackUserIds = null;
	let trackDateRange = { start: null, end: null, shortcut: 'all' };
	let activeJourneyUserId = null;
	let selectedJourneys = [];
	let journeyGapMinutes = 30;
	let journeySort = { column: 'start', direction: 'desc' };
	let accuracyCircle = null;
	const collapsedHistoryUserIds = new Set();
	const collapsedHistoryJourneyKeys = new Set();
	const hiddenTrackUserIds = new Set();
	let trackPointStyle = 'teardrop';

	function startOfLocalDay(date)
	{
		return new Date(date.getFullYear(), date.getMonth(), date.getDate());
	}

	function formatDateInput(date)
	{
		const year = date.getFullYear();
		const month = String(date.getMonth() + 1).padStart(2, '0');
		const day = String(date.getDate()).padStart(2, '0');
		return `${year}-${month}-${day}`;
	}

	function isInTrackDateRange(timestamp)
	{
		if (!timestamp) return trackDateRange.shortcut === 'all';
		return (trackDateRange.start === null || timestamp >= trackDateRange.start)
			&& (trackDateRange.end === null || timestamp < trackDateRange.end);
	}

	function filterTrackByDate(track)
	{
		// Sorted here as well as on recording, because history stored before that fix can
		// still hold late-arriving fixes out of order.
		return (Array.isArray(track) ? track : [])
			.filter((point) => isInTrackDateRange(point.timestamp))
			.sort((first, second) => (first.timestamp || 0) - (second.timestamp || 0));
	}

	function isJourneySelected(userId, start, end)
	{
		return selectedJourneys.some((selection) => selection.userId === userId && selection.start === start && selection.end === end);
	}

	function getJourneySortValue(journey, column)
	{
		if (column === 'destination')
		{
			const destination = journey.points[journey.points.length - 1];
			return zoneAt(destination.lat, destination.lon);
		}
		if (column === 'duration') return journey.travelEnd - journey.travelStart;
		if (column === 'speed')
		{
			const durationHours = (journey.travelEnd - journey.travelStart) / 3600000;
			return durationHours > 0 ? calculateJourneyDistanceMeters(journey.travelPoints) / 1000 / durationHours : 0;
		}
		return journey.travelStart;
	}

	function sortJourneys(journeys)
	{
		const multiplier = journeySort.direction === 'asc' ? 1 : -1;
		return journeys.slice().sort((first, second) =>
		{
			const firstValue = getJourneySortValue(first, journeySort.column);
			const secondValue = getJourneySortValue(second, journeySort.column);
			const comparison = typeof firstValue === 'string'
				? firstValue.localeCompare(secondValue)
				: firstValue - secondValue;
			return comparison * multiplier || second.travelStart - first.travelStart;
		});
	}

	function updateJourneySortHeaders()
	{
		document.querySelectorAll('[data-journey-sort]').forEach((button) =>
		{
			const active = button.dataset.journeySort === journeySort.column;
			button.classList.toggle('active', active);
			button.parentElement.setAttribute('aria-sort', active
				? (journeySort.direction === 'asc' ? 'ascending' : 'descending')
				: 'none');
		});
	}

	/** Selections are always for one user, so picking another user's journey starts a new set. */
	function toggleJourneySelection(selection)
	{
		if (selectedJourneys.length && selectedJourneys[0].userId !== selection.userId)
		{
			selectedJourneys = [];
		}

		const index = selectedJourneys.findIndex((current) => current.userId === selection.userId
			&& current.start === selection.start
			&& current.end === selection.end);
		if (index >= 0) selectedJourneys.splice(index, 1);
		else selectedJourneys.push(selection);
	}

	function isTrackUserShown(user)
	{
		if (selectedJourneys.length)
		{
			return selectedJourneys.some((selection) => selection.userId === user.id);
		}
		return selectedTrackUserIds === null || selectedTrackUserIds.has(user.id);
	}

	function getSelectedTrack(user)
	{
		if (hiddenTrackUserIds.has(user.id)) return [];
		const track = filterTrackByDate(user.track);
		if (!selectedJourneys.length) return track;
		const ranges = selectedJourneys.filter((selection) => selection.userId === user.id);
		if (!ranges.length) return [];
		return track.filter((point) => ranges.some((range) => point.timestamp >= range.start && point.timestamp <= range.end));
	}

	function getJourneyKey(userId, journey)
	{
		return `${userId}/${journey.start}/${journey.end}`;
	}

	function getDisplayedTrack(user)
	{
		const track = getSelectedTrack(user);
		const collapsedRanges = buildJourneys(track)
			.filter((journey) => collapsedHistoryJourneyKeys.has(getJourneyKey(user.id, journey)));
		return track.filter((point) => !collapsedRanges.some((journey) => point.timestamp >= journey.start && point.timestamp <= journey.end));
	}

	function buildJourneys(track)
	{
		const points = filterTrackByDate(track)
			.filter((point) => Number.isFinite(point.timestamp))
			.sort((first, second) => first.timestamp - second.timestamp);
		const journeys = [];
		const gapMilliseconds = journeyGapMinutes * 60 * 1000;

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
		journeys.forEach((journey) => setJourneyTravelBounds(journey));

		// Oldest first, so reading down the list follows the user forwards in time.
		return journeys;
	}

	/** The zone a coordinate falls inside, or an empty string when it isn't in one. */
	function zoneAt(lat, lon)
	{
		if (typeof lat !== 'number' || typeof lon !== 'number') return '';

		const match = trackWaypoints.find((waypoint) => typeof waypoint.lat === 'number'
			&& typeof waypoint.lon === 'number'
			&& calculateJourneyDistanceMeters([{ lat, lon }, waypoint]) <= (Number(waypoint.rad) || 100));

		return match ? match.desc : '';
	}

	function formatJourneyDuration(journey)
	{
		const totalMinutes = Math.max(0, Math.round((journey.travelEnd - journey.travelStart) / 60000));
		return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`;
	}

	function calculateJourneyDistanceMeters(points)
	{
		const earthRadiusMeters = 6371000;
		const toRadians = (degrees) => degrees * Math.PI / 180;
		let distance = 0;

		for (let index = 1; index < points.length; index++)
		{
			const previous = points[index - 1];
			const current = points[index];
			if (![previous.lat, previous.lon, current.lat, current.lon].every(Number.isFinite)) continue;
			const latitudeDelta = toRadians(current.lat - previous.lat);
			const longitudeDelta = toRadians(current.lon - previous.lon);
			const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(toRadians(previous.lat)) * Math.cos(toRadians(current.lat)) * Math.sin(longitudeDelta / 2) ** 2;
			distance += earthRadiusMeters * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
		}

		return distance;
	}

	function calculateDistanceMeters(previous_lat, previous_lon, current_lat, current_lon)
	{
		const earthRadiusMeters = 6371000;
		const toRadians = (degrees) => degrees * Math.PI / 180;

		if (![previous_lat, previous_lon, current_lat, current_lon].every(Number.isFinite)) return null;
		const latitudeDelta = toRadians(current_lat - previous_lat);
		const longitudeDelta = toRadians(current_lon - previous_lon);
		const value = Math.sin(latitudeDelta / 2) ** 2 + Math.cos(toRadians(previous_lat)) * Math.cos(toRadians(current_lat)) * Math.sin(longitudeDelta / 2) ** 2;
		return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
	}

	function setJourneyTravelBounds(journey)
	{
		const points = journey.points;
		let firstMovingPoint = null;
		let lastMovingPoint = null;
		const minimumMovingSpeedKmh = 2;

		for (let index = 1; index < points.length; index++)
		{
			const previous = points[index - 1];
			const current = points[index];
			const durationHours = (current.timestamp - previous.timestamp) / 3600000;
			if (durationHours <= 0) continue;
			const speedKmh = calculateJourneyDistanceMeters([previous, current]) / 1000 / durationHours;
			if (speedKmh < minimumMovingSpeedKmh) continue;
			// The leg started at the previous point, so that's when travel began.
			if (firstMovingPoint === null) firstMovingPoint = index - 1;
			lastMovingPoint = index;
		}

		journey.travelStart = firstMovingPoint === null ? points[0].timestamp : points[firstMovingPoint].timestamp;
		journey.travelEnd = lastMovingPoint === null ? points[points.length - 1].timestamp : points[lastMovingPoint].timestamp;
		journey.travelPoints = firstMovingPoint === null
			? points
			: points.slice(firstMovingPoint, lastMovingPoint + 1);
	}

	function formatJourneyAverageSpeed(journey)
	{
		const durationHours = (journey.travelEnd - journey.travelStart) / 3600000;
		if (durationHours <= 0 || journey.travelPoints.length < 2) return '-';
		const speedKmh = calculateJourneyDistanceMeters(journey.travelPoints) / 1000 / durationHours;
		const speed = mapSpeedUnit === 'mph' ? speedKmh * 0.621371 : speedKmh;
		return `${speed.toFixed(1)} ${mapSpeedUnit === 'mph' ? 'mph' : 'km/h'}`;
	}

	function buildTrackPointsTsv(user)
	{
		const points = getDisplayedTrack(user).slice().sort((first, second) => first.timestamp - second.timestamp);
		const receivedFields = [...new Set(points.flatMap((point) => Object.keys(point.raw || {})))].sort();
		const rows = [[
			'timestamp', 'local_time', 'latitude', 'longitude', 'accuracy_m', 'reported_speed_kmh', 'distance_m', 'implied_speed_kmh',
			...receivedFields.map((field) => `received_${field}`),
		]];
		points.forEach((point, index) =>
		{
			const previous = points[index - 1];
			const distance = previous ? calculateJourneyDistanceMeters([previous, point]) : null;
			const durationHours = previous ? (point.timestamp - previous.timestamp) / 3600000 : 0;
			const impliedSpeed = distance !== null && durationHours > 0 ? distance / 1000 / durationHours : null;
			rows.push([
				new Date(point.timestamp).toISOString(),
				new Date(point.timestamp).toLocaleString(),
				point.lat,
				point.lon,
				Number.isFinite(point.accuracy) ? point.accuracy : '',
				Number.isFinite(point.velocity) ? point.velocity : '',
				distance === null ? '' : distance.toFixed(1),
				impliedSpeed === null ? '' : impliedSpeed.toFixed(1),
				...receivedFields.map((field) =>
				{
					const value = point.raw && point.raw[field];
					if (value === undefined || value === null) return '';
					const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
					return text.replace(/[\t\r\n]+/g, ' ');
				}),
			]);
		});
		return rows.map((row) => row.join('\t')).join('\n');
	}

	function renderTrackMapTitle()
	{
		const title = document.getElementById('trackMapTitle');
		title.classList.toggle('journey-active', selectedJourneys.length > 0);
		if (!selectedJourneys.length)
		{
			title.textContent = Homey.__('settings.map.intro');
			return;
		}

		if (selectedJourneys.length > 1)
		{
			title.textContent = Homey.__('settings.map.journeysSelected').replace('[[count]]', selectedJourneys.length);
			return;
		}

		const start = new Date(selectedJourneys[0].travelStart || selectedJourneys[0].start);
		title.textContent = Homey.__('settings.map.journeyHeading')
			.replace('[[date]]', start.toLocaleDateString())
			.replace('[[time]]', start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
	}

	/** Combined distance and travel time of every journey currently drawn on the map. */
	function renderTrackMapTotals()
	{
		let metres = 0;
		let milliseconds = 0;

		trackUsers.filter(isTrackUserShown).forEach((user) =>
		{
			buildJourneys(getDisplayedTrack(user)).forEach((journey) =>
			{
				metres += calculateJourneyDistanceMeters(journey.points);
				milliseconds += Math.max(0, journey.travelEnd - journey.travelStart);
			});
		});

		const totals = document.getElementById('trackMapTotals');
		if (!metres && !milliseconds)
		{
			totals.textContent = '';
			return;
		}

		const useMiles = mapSpeedUnit === 'mph';
		const distance = useMiles ? (metres / 1000) * 0.621371 : metres / 1000;
		const minutes = Math.round(milliseconds / 60000);
		totals.textContent = Homey.__('settings.map.totals')
			.replace('[[distance]]', `${distance.toFixed(1)} ${useMiles ? 'mi' : 'km'}`)
			.replace('[[duration]]', `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`);
	}

	function renderJourneys()
	{
		const panel = document.getElementById('journeyPanel');
		const usersPanel = document.querySelector('.track-filter-users');
		const filterHint = document.getElementById('trackFilterHint');
		const body = document.getElementById('journeyTableBody');
		const user = trackUsers.find((item) => item.id === activeJourneyUserId);
		panel.classList.toggle('hidden', !user);
		usersPanel.classList.toggle('hidden', Boolean(user));
		updateMapFilterHelp(Boolean(user));
		filterHint.textContent = Homey.__(user ? 'settings.map.journeySelectHint' : 'settings.map.filterHint');
		body.textContent = '';
		if (!user)
		{
			renderTrackMapTitle();
			return;
		}

		document.getElementById('journeyTitle').textContent = Homey.__('settings.map.journeysTitle').replace('[[user]]', user.name);
		const journeys = buildJourneys(user.track);
		// Re-anchored to the rebuilt journeys, dropping any that no longer exist.
		selectedJourneys = selectedJourneys
			.filter((selection) => selection.userId === user.id)
			.map((selection) =>
			{
				const current = journeys.find((journey) => journey.start === selection.start);
				return current
					? { ...selection, end: current.end, travelStart: current.travelStart, travelEnd: current.travelEnd }
					: null;
			})
			.filter(Boolean);
		renderTrackMapTitle();
		updateJourneySortHeaders();

		if (!journeys.length)
		{
			const row = document.createElement('tr');
			const cell = document.createElement('td');
			cell.colSpan = 5;
			cell.textContent = Homey.__('settings.map.noJourneys');
			row.appendChild(cell);
			body.appendChild(row);
			return;
		}

		sortJourneys(journeys).forEach((journey) =>
		{
			const row = document.createElement('tr');
			row.classList.toggle('active', isJourneySelected(user.id, journey.start, journey.end));
			const startCell = document.createElement('td');
			startCell.textContent = new Date(journey.travelStart).toLocaleString();
			const destinationCell = document.createElement('td');
			const destination = journey.points[journey.points.length - 1];
			destinationCell.textContent = zoneAt(destination.lat, destination.lon);
			const durationCell = document.createElement('td');
			durationCell.textContent = formatJourneyDuration(journey);
			const speedCell = document.createElement('td');
			speedCell.textContent = formatJourneyAverageSpeed(journey);
			const deleteCell = document.createElement('td');
			const deleteButton = document.createElement('button');
			deleteButton.type = 'button';
			deleteButton.className = 'journey-delete-button';
			deleteButton.setAttribute('aria-label', Homey.__('settings.map.deleteJourneyAria'));
			deleteButton.setAttribute('title', Homey.__('settings.map.deleteJourneyAria'));
			deleteButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3a1 1 0 0 0-1 1v1H4v2h16V5h-4V4a1 1 0 0 0-1-1H9zM5 8l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12H5zm4 3h2v8H9v-8zm4 0h2v8h-2v-8z"/></svg>';
			deleteButton.addEventListener('click', (event) =>
			{
				event.stopPropagation();
				Homey.confirm(Homey.__('settings.map.deleteJourneyConfirm'), null, (confirmErr, confirmed) =>
				{
					if (confirmErr) return Homey.alert(confirmErr);
					if (!confirmed) return;
					deleteButton.disabled = true;
					Homey.api('POST', '/tracks/delete-journey', {
						userId: user.id,
						start: journey.start,
						end: journey.end,
					}, (deleteErr) =>
					{
						if (deleteErr)
						{
							deleteButton.disabled = false;
							Homey.alert(deleteErr);
							return;
						}
						selectedJourneys = [];
						loadTracks(true);
					});
				});
			});
			deleteCell.appendChild(deleteButton);
			row.append(startCell, destinationCell, durationCell, speedCell, deleteCell);
			row.addEventListener('click', () =>
			{
				toggleJourneySelection({
					userId: user.id,
					start: journey.start,
					end: journey.end,
					travelStart: journey.travelStart,
					travelEnd: journey.travelEnd,
				});
				renderJourneys();
				renderTracks(trackUsers);
				renderTrackHistory(trackUsers);
			});
			body.appendChild(row);
		});
	}

	function formatMapSpeed(location)
	{
		const receivedAt = location.receivedAt || location.timestamp;
		const fresh = receivedAt && Date.now() - receivedAt < 60 * 1000;
		if (!fresh || typeof location.velocity !== 'number' || location.velocity <= 2) return null;

		const speed = mapSpeedUnit === 'mph' ? location.velocity * 0.621371 : location.velocity;
		return `${speed.toFixed(1)} ${mapSpeedUnit === 'mph' ? 'mph' : 'km/h'}`;
	}

	function refreshTrackDateFilter()
	{
		selectedJourneys = [];
		renderJourneys();
		renderTracks(trackUsers);
		renderTrackHistory(trackUsers);
	}

	function selectTrackDateShortcut(shortcut, refresh = true)
	{
		const today = startOfLocalDay(new Date());
		const tomorrow = new Date(today);
		tomorrow.setDate(tomorrow.getDate() + 1);
		let start = null;
		let end = null;

		if (shortcut === 'today')
		{
			start = today;
			end = tomorrow;
		} else if (shortcut === 'yesterday')
		{
			start = new Date(today);
			start.setDate(start.getDate() - 1);
			end = today;
		} else if (shortcut === 'lastWeek')
		{
			start = new Date(today);
			start.setDate(start.getDate() - 6);
			end = tomorrow;
		}

		trackDateRange = {
			start: start ? start.getTime() : null,
			end: end ? end.getTime() : null,
			shortcut,
		};
		document.getElementById('trackDateFrom').value = start ? formatDateInput(start) : '';
		document.getElementById('trackDateTo').value = end ? formatDateInput(new Date(end.getTime() - 1)) : '';
		document.querySelectorAll('.track-date-shortcut').forEach((button) =>
		{
			button.classList.toggle('active', button.dataset.trackRange === shortcut);
		});
		if (refresh) refreshTrackDateFilter();
	}

	function ensureTrackMap(initialCenter = FALLBACK_ZONE_CENTER)
	{
		if (trackMap) return;

		trackMap = L.map('trackMap').setView(initialCenter, 13);
		trackMap.createPane('zones');
		trackMap.getPane('zones').style.zIndex = 400;

		// Zone pins sit above the zone circles but below the track points.
		trackMap.createPane('zonePins');
		trackMap.getPane('zonePins').style.zIndex = 440;

		trackMap.createPane('trackPoints');
		trackMap.getPane('trackPoints').style.zIndex = 450;

		// Journey flags sit above the avatar markers so they stay readable where a journey
		// ends at a user's current position.
		trackMap.createPane('journeyFlags');
		trackMap.getPane('journeyFlags').style.zIndex = 650;

		// Teardrop icon size and overlap-filtering are zoom-dependent, so the whole
		// track needs redrawing (not just resizing) whenever the zoom level changes.
		// adjustViewport is false so this never recenters the map the user just zoomed.
		trackMap.on('zoomend', () => renderTracks(trackUsers, false, false));
		trackMap.on('dragend zoomend', pinTrackViewport);
		createOsmTileLayer().addTo(trackMap);
		updateTrackScale();

		trackMap.on('click', () =>
		{
			if (accuracyCircle)
			{
				accuracyCircle.remove();
				accuracyCircle = null;
			}
		});

		trackMap.on('contextmenu', (event) =>
		{
			L.DomEvent.preventDefault(event.originalEvent);
			showTrackContextMenu(event.originalEvent.clientX, event.originalEvent.clientY);
		});

		// Leaflet has no built-in long-press event, so it's detected manually from touch
		// timing to give touch users the same menu as a desktop right-click.
		let trackLongPressTimer = null;
		const trackMapContainer = trackMap.getContainer();
		trackMapContainer.addEventListener('touchstart', (event) =>
		{
			if (event.touches.length !== 1) return;
			const touch = event.touches[0];
			trackLongPressTimer = setTimeout(() => showTrackContextMenu(touch.clientX, touch.clientY), 550);
		});
		trackMapContainer.addEventListener('touchmove', () => clearTimeout(trackLongPressTimer));
		trackMapContainer.addEventListener('touchend', () => clearTimeout(trackLongPressTimer));
		trackMapContainer.addEventListener('touchcancel', () => clearTimeout(trackLongPressTimer));
	}

	function updateTrackScale()
	{
		if (!trackMap) return;
		if (trackScaleControl) trackScaleControl.remove();
		trackScaleControl = L.control.scale({
			position: 'bottomleft',
			metric: mapSpeedUnit !== 'mph',
			imperial: mapSpeedUnit === 'mph',
		}).addTo(trackMap);
	}

	function getTrackPointRadius()
	{
		const zoom = trackMap.getZoom();
		return zoom >= 17 ? 5 : Math.max(1, Math.min(4, zoom - 10));
	}

	/** Leaflet reports our own recentres like user gestures, so those are timestamped and ignored. */
	function pinTrackViewport()
	{
		if (Date.now() - lastProgrammaticTrackViewAt < 1200) return;
		trackViewportPinned = true;
	}

	function centreTrackMapOn(lat, lon)
	{
		trackViewportPinned = false;
		lastProgrammaticTrackViewAt = Date.now();
		trackMap.panTo([lat, lon]);
	}

	function renderTrackZones()
	{
		trackZoneLayers.forEach((layer) => trackMap.removeLayer(layer));
		trackZoneLayers.length = 0;

		// A popup element can only belong to one popup, so the circle and its pin each need their own.
		function buildZonePopup(waypoint)
		{
			const popupContent = document.createElement('div');
			const popupDetails = document.createElement('div');
			popupDetails.textContent = `${waypoint.desc}\n${waypoint.lat}, ${waypoint.lon}\nRadius: ${waypoint.rad || 100}m`;
			popupDetails.style.whiteSpace = 'pre-line';
			const editButton = document.createElement('button');
			editButton.type = 'button';
			editButton.className = 'homey-button-secondary-shadow-small track-zone-edit-button';
			editButton.setAttribute('aria-label', Homey.__('settings.zones.editAria'));
			editButton.setAttribute('title', Homey.__('settings.zones.editAria'));
			editButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.03 0-1.42l-2.34-2.34a.9959.9959 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.82z"/></svg>';
			editButton.addEventListener('click', (event) =>
			{
				event.stopPropagation();
				trackMap.closePopup();
				document.getElementById('trackFilterModal').classList.add('hidden');
				openZoneEditor(waypoint, { scope: waypoint.scope, userId: waypoint.userId });
			});
			popupContent.append(popupDetails, editButton);
			return popupContent;
		}

		trackWaypoints.forEach((waypoint) =>
		{
			if (typeof waypoint.lat !== 'number' || typeof waypoint.lon !== 'number') return;
			const circle = L.circle([waypoint.lat, waypoint.lon], {
				pane: 'zones',
				color: '#666',
				fillColor: '#999',
				fillOpacity: 0.15,
				radius: Number(waypoint.rad) || 100,
			}).addTo(trackMap);
			circle.bindPopup(buildZonePopup(waypoint));
			trackZoneLayers.push(circle);

			const pin = L.marker([waypoint.lat, waypoint.lon], {
				pane: 'zonePins',
				icon: L.divIcon({
					className: 'zone-pin',
					html: ZONE_PIN_SVG,
					iconSize: [24, 32],
					iconAnchor: [12, 32],
				}),
			}).addTo(trackMap);
			pin.bindTooltip(waypoint.desc, { direction: 'top', offset: [0, -30] });
			pin.bindPopup(buildZonePopup(waypoint));
			trackZoneLayers.push(pin);
		});
	}

	// Shared by the Filter checkboxes and the map's right-click/long-press menu, so both
	// stay in sync when a user is shown or hidden from either place.
	function setTrackUserVisibility(user, visible, refreshFilterList = true)
	{
		if (selectedTrackUserIds === null)
		{
			selectedTrackUserIds = new Set(trackUsers.map((item) => item.id));
		}
		if (visible) selectedTrackUserIds.add(user.id);
		else selectedTrackUserIds.delete(user.id);
		if (!visible) selectedJourneys = selectedJourneys.filter((selection) => selection.userId !== user.id);
		if (!visible && journeyPickerUserId === user.id) journeyPickerMenu.classList.add('hidden');
		// Showing/hiding a user shouldn't move the map the user is currently looking at.
		renderTracks(trackUsers, false, false);
		renderTrackHistory(trackUsers);
		renderJourneys();
		if (refreshFilterList) renderTrackFilter(trackUsers);
	}

	function renderTrackFilter(users)
	{
		const filterList = document.getElementById('trackFilterList');
		filterList.textContent = '';

		if (!users.length)
		{
			const emptyMessage = document.createElement('p');
			emptyMessage.textContent = Homey.__('settings.map.noUsersToFilter');
			filterList.appendChild(emptyMessage);
			return;
		}

		users.forEach((user) =>
		{
			const row = document.createElement('div');
			row.className = 'track-filter-user-row';
			const label = document.createElement('label');
			label.className = 'homey-form-checkbox';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.className = 'homey-form-checkbox-input';
			checkbox.checked = selectedTrackUserIds === null || selectedTrackUserIds.has(user.id);
			checkbox.addEventListener('change', () =>
			{
				setTrackUserVisibility(user, checkbox.checked, false);
			});

			const checkmark = document.createElement('span');
			checkmark.className = 'homey-form-checkbox-checkmark';
			const text = document.createElement('span');
			text.className = 'homey-form-checkbox-text';
			text.textContent = user.name;
			label.append(checkbox, checkmark, text);
			const journeysButton = document.createElement('button');
			journeysButton.type = 'button';
			journeysButton.className = 'homey-button-secondary-shadow-small';
			journeysButton.textContent = Homey.__('settings.map.myJourneys');
			journeysButton.addEventListener('click', () =>
			{
				activeJourneyUserId = user.id;
				selectedJourneys = [];
				renderJourneys();
				renderTracks(trackUsers);
				renderTrackHistory(trackUsers);
			});
			row.append(label, journeysButton);
			filterList.appendChild(row);
		});
	}

	function renderTracks(users, preserveViewport = false, adjustViewport = true)
	{
		ensureTrackMap();

		trackLayers.forEach((layer) => trackMap.removeLayer(layer));
		if (accuracyCircle)
		{
			accuracyCircle.remove();
			accuracyCircle = null;
		}

		trackLayers.length = 0;
		trackPointLayers.length = 0;
		trackPointMarkers = new WeakMap();

		const bounds = [];
		let newestPosition = null;

		users
			.filter(isTrackUserShown)
			.forEach((user, index) =>
			{
				const color = TRACK_COLORS[index % TRACK_COLORS.length];
				const track = getDisplayedTrack(user);
				const journeys = buildJourneys(track);

				// One line per journey, so nothing is drawn across a gap where the phone had no
				// connectivity or between separate trips.
				journeys.forEach((journey) =>
				{
					const coordinates = journey.points
						.filter((point) => typeof point.lat === 'number' && typeof point.lon === 'number')
						.map((point) => [point.lat, point.lon]);
					if (coordinates.length < 2) return;
					trackLayers.push(L.polyline(coordinates, { color }).addTo(trackMap));
				});

				const classicRadius = getTrackPointRadius();
				const teardropWidth = Math.max(14, classicRadius * 5);
				// Keeps a minimum on-screen gap between points so closely spaced ones
				// (e.g. while stationary) don't render on top of each other.
				const minPointGapPx = (trackPointStyle === 'classic' ? classicRadius * 2 : teardropWidth) + 5;
				let lastRenderedScreenPoint = null;

				track.forEach((point, pointIndex) =>
				{
					if (typeof point.lat !== 'number' || typeof point.lon !== 'number') return;
					bounds.push([point.lat, point.lon]);
					if (!newestPosition || (point.timestamp || 0) > newestPosition.timestamp)
					{
						newestPosition = { lat: point.lat, lon: point.lon, timestamp: point.timestamp || 0 };
					}

					const screenPoint = trackMap.latLngToContainerPoint([point.lat, point.lon]);
					if (pointIndex !== 0 && lastRenderedScreenPoint && screenPoint.distanceTo(lastRenderedScreenPoint) < minPointGapPx)
					{
						return;
					}
					lastRenderedScreenPoint = screenPoint;

					// Point the teardrop at the next waypoint; for the last point (no "next"),
					// keep pointing the way travel was already heading. Unused for the classic style.
					const next = track[pointIndex + 1];
					const prev = track[pointIndex - 1];
					let pointBearing = 0;
					if (next && typeof next.lat === 'number' && typeof next.lon === 'number')
					{
						pointBearing = computeBearing(point.lat, point.lon, next.lat, next.lon);
					} else if (prev && typeof prev.lat === 'number' && typeof prev.lon === 'number')
					{
						pointBearing = computeBearing(prev.lat, prev.lon, point.lat, point.lon);
					}
					// The SVG's tip sits at the bottom-center, which is rotated to face south
					// by default, so rotating by (bearing - 180) points it at the given bearing.
					const rotation = (pointBearing - 180 + 360) % 360;
					let pointMarker;
					if (trackPointStyle === 'classic')
					{
						pointMarker = L.circleMarker([point.lat, point.lon], {
							pane: 'trackPoints',
							radius: classicRadius,
							weight: 1,
							color,
							fillColor: color,
							fillOpacity: 0.8,
						});
					} else
					{
						// Built from a small circle plus a tapering tail rather than a single SVG
						// path, so the circle's size can be tuned independently of the tail length.
						const circleDiameter = Math.max(10, Math.round(teardropWidth * 0.55));
						const circleRadius = circleDiameter / 2;
						const tailHalfWidth = circleRadius;
						const tailHeight = Math.round(teardropWidth * 1.3);
						const tailTop = circleRadius;
						const iconHeight = tailTop + tailHeight;
						// Anchored and rotated around the circle's own center (not the tail tip), so
						// the waypoint coordinate sits in the middle of the circle and connecting
						// lines meet there, with the tail swinging around it to show direction.
						const originPercent = (circleRadius / iconHeight) * 100;
						const teardropIcon = L.divIcon({
							className: 'track-teardrop-icon',
							html: `<div style="position: relative; width: ${circleDiameter}px; height: ${iconHeight}px; transform-origin: 50% ${originPercent}%; transform: rotate(${rotation}deg);">`
								+ `<div style="position: absolute; top: 0; left: 0; width: ${circleDiameter}px; height: ${circleDiameter}px; border-radius: 50%; background: ${color};"></div>`
								+ `<div style="position: absolute; top: ${tailTop}px; left: 50%; margin-left: -${tailHalfWidth}px; width: 0; height: 0; border-left: ${tailHalfWidth}px solid transparent; border-right: ${tailHalfWidth}px solid transparent; border-top: ${tailHeight}px solid ${color};"></div>`
								+ `</div>`,
							iconSize: [circleDiameter, iconHeight],
							iconAnchor: [circleRadius, circleRadius],
						});
						pointMarker = L.marker([point.lat, point.lon], {
							pane: 'trackPoints',
							icon: teardropIcon,
						});
					}
					pointMarker.on('click', (event) =>
					{
						if (accuracyCircle)
						{
							accuracyCircle.remove();
							accuracyCircle = null;
						}

						accuracyCircle = L.circle([point.lat, point.lon], {
							color: '#5BF527',
							fillColor: '#999',
							fillOpacity: 0.15,
							radius: Number(point.acc) || 100,
							interactive: false
						}).addTo(trackMap);

						highlightHistoryRow(point);
					});
					pointMarker.on('mouseover', () =>
					{
						if (accuracyCircle)
						{
							accuracyCircle.remove();
						}

						accuracyCircle = L.circle([point.lat, point.lon], {
							color: '#5BF527',
							fillColor: '#999',
							fillOpacity: 0.15,
							radius: Number(point.acc) || 100,
							interactive: false
						}).addTo(trackMap);
					});

					pointMarker.on('mouseout', () =>
					{
						if (accuracyCircle)
						{
							accuracyCircle.remove();
							accuracyCircle = null;
						}
					});
					const popupContent = document.createElement('div');
					const popupDetails = document.createElement('div');
					popupDetails.textContent = `${user.name}\n${point.lat}, ${point.lon}\n${new Date(point.timestamp || Date.now()).toLocaleString()}`;
					popupDetails.style.whiteSpace = 'pre-line';
					const deletePointButton = document.createElement('button');
					deletePointButton.type = 'button';
					deletePointButton.className = 'homey-button-secondary-shadow-small track-point-delete-button';
					deletePointButton.setAttribute('aria-label', Homey.__('settings.map.deletePoint'));
					deletePointButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 3a1 1 0 0 0-1 1v1H4v2h16V5h-4V4a1 1 0 0 0-1-1H9zM5 8l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12H5zm4 3h2v8H9v-8zm4 0h2v8h-2v-8z"/></svg>';
					const deletePointLabel = document.createElement('span');
					deletePointLabel.textContent = Homey.__('settings.map.deletePoint');
					deletePointButton.appendChild(deletePointLabel);
					deletePointButton.addEventListener('click', () =>
					{
						Homey.confirm(Homey.__('settings.map.deletePointConfirm'), null, (confirmErr, confirmed) =>
						{
							if (confirmErr) return Homey.alert(confirmErr);
							if (!confirmed) return;
							deletePointButton.disabled = true;
							Homey.api('POST', '/tracks/delete-point', {
								userId: user.id,
								timestamp: point.timestamp,
								lat: point.lat,
								lon: point.lon,
							}, (deleteErr) =>
							{
								if (deleteErr)
								{
									deletePointButton.disabled = false;
									Homey.alert(deleteErr);
									return;
								}
								trackMap.closePopup();
								loadTracks(true);
							});
						});
					});
					popupContent.append(popupDetails, deletePointButton);
					pointMarker.bindPopup(popupContent);
					pointMarker.addTo(trackMap);
					trackLayers.push(pointMarker);
					trackPointLayers.push(pointMarker);
					trackPointMarkers.set(point, pointMarker);
				});

				journeys.forEach((journey) =>
				{
					if (journey.points.length < 2) return;
					const endPoint = journey.points[journey.points.length - 1];
					if (typeof endPoint.lat !== 'number' || typeof endPoint.lon !== 'number') return;
					const flag = L.marker([endPoint.lat, endPoint.lon], {
						pane: 'journeyFlags',
						icon: L.divIcon({
							className: 'track-flag-icon',
							html: CHEQUERED_FLAG_SVG,
							iconSize: [22, 22],
							// Anchored bottom-left with a nudge so the flag stands clear of an
							// avatar marker sitting on the same point.
							iconAnchor: [-8, 24],
						}),
					}).addTo(trackMap);
					flag.bindTooltip(`${user.name} - ${Homey.__('settings.map.journeyEndFlag')} ${new Date(endPoint.timestamp).toLocaleString()}`);
					flag.on('dblclick', (event) =>
					{
						// Otherwise the map's own double-click zoom fires as well.
						L.DomEvent.stopPropagation(event);
						activeJourneyUserId = user.id;
						toggleJourneySelection({
							userId: user.id,
							start: journey.start,
							end: journey.end,
							travelStart: journey.travelStart,
							travelEnd: journey.travelEnd,
						});
						renderJourneys();
						renderTracks(trackUsers);
						renderTrackHistory(trackUsers);
					});
					trackLayers.push(flag);
				});

				const journeyEnd = selectedJourneys.length
					? track.filter((point) => typeof point.lat === 'number' && typeof point.lon === 'number')
						.reduce((latest, point) => !latest || (point.timestamp || 0) > (latest.timestamp || 0) ? point : latest, null)
					: null;
				const last = journeyEnd || (user.lastLocation && isInTrackDateRange(user.lastLocation.timestamp)
					? user.lastLocation
					: null);
				if (last && typeof last.lat === 'number' && typeof last.lon === 'number')
				{
					if (!newestPosition || (last.timestamp || 0) >= newestPosition.timestamp)
					{
						newestPosition = { lat: last.lat, lon: last.lon, timestamp: last.timestamp || 0 };
					}
					const formattedSpeed = selectedJourneys.length ? null : formatMapSpeed(last);
					const speedLabel = formattedSpeed ? `<div class="track-speed-label">${formattedSpeed}</div>` : '';
					const icon = user.avatarBase64
						? L.divIcon({
							className: 'track-avatar-icon',
							html: `${speedLabel}<img src="data:image/jpeg;base64,${user.avatarBase64}" style="border-color: ${color};">`,
							iconSize: [36, 36],
						})
						: L.divIcon({
							className: 'track-avatar-icon',
							html: `${speedLabel}<div class="track-avatar-fallback" style="background: ${color};"></div>`,
							iconSize: [36, 36],
						});

					const marker = L.marker([last.lat, last.lon], { icon }).addTo(trackMap).bindTooltip(user.name);
					trackLayers.push(marker);
					bounds.push([last.lat, last.lon]);
				}
			});

		if (!adjustViewport)
		{
			// Called just to resize/re-filter markers after a zoom change - the user's
			// current view should be left exactly as they set it.
		} else if (preserveViewport)
		{
			// Background refresh: leave the view alone while the user has panned or zoomed away.
			if (!trackViewportPinned && newestPosition)
			{
				lastProgrammaticTrackViewAt = Date.now();
				trackMap.panInside([newestPosition.lat, newestPosition.lon], {
					paddingTopLeft: [30, 30],
					paddingBottomRight: [30, 30],
				});
			}
		} else if (bounds.length)
		{
			// A deliberate re-render (filter or journey change) resets the view, so following resumes.
			trackViewportPinned = false;
			lastProgrammaticTrackViewAt = Date.now();
			trackMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 16 });
		}

		renderTrackMapTotals();
	}

	/** Reveals and marks the Logged coordinates row for a point clicked on the map. */
	function highlightHistoryRow(point)
	{
		if (!document.getElementById('tabPanelMap').classList.contains('history-expanded')) return;
		const row = trackHistoryRows.get(point);
		if (!row) return;

		document.querySelectorAll('.track-history-point.highlighted')
			.forEach((element) => element.classList.remove('highlighted'));

		// The row's table is hidden while its user group is collapsed, so open it first.
		const table = row.closest('.track-history-table');
		if (table && table.classList.contains('hidden'))
		{
			const heading = table.parentElement.querySelector('.track-history-user');
			if (heading) heading.click();
		}

		row.classList.add('highlighted');
		row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
	}

	function renderTrackHistory(users)
	{
		const historyList = document.getElementById('trackHistoryList');
		historyList.textContent = '';
		trackHistoryRows = new WeakMap();
		const userTracks = users
			.filter(isTrackUserShown)
			.map((user) => ({
				user,
				points: getSelectedTrack(user)
					.filter((point) => typeof point.lat === 'number' && typeof point.lon === 'number')
					.sort((first, second) => (second.timestamp || 0) - (first.timestamp || 0)),
			}))
			.filter(({ points }) => points.length);

		if (!userTracks.length)
		{
			historyList.textContent = Homey.__('settings.map.noHistory');
			return;
		}

		userTracks.forEach(({ user, points }) =>
		{
			const group = document.createElement('div');
			group.className = 'track-history-row';
			const heading = document.createElement('button');
			heading.type = 'button';
			heading.className = 'track-history-user';
			const collapseIcon = document.createElement('span');
			collapseIcon.className = 'track-history-collapse-icon';
			collapseIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';
			const headingLabel = document.createElement('span');
			headingLabel.textContent = user.name;
			const headingCount = document.createElement('span');
			headingCount.className = 'track-history-count';
			headingCount.textContent = `(${points.length})`;
			heading.append(collapseIcon, headingLabel, headingCount);
			const table = document.createElement('table');
			table.className = 'track-history-table';

			const isCollapsed = collapsedHistoryUserIds.has(user.id);
			collapseIcon.classList.toggle('expanded', !isCollapsed);
			table.classList.toggle('hidden', isCollapsed);
			heading.setAttribute('aria-expanded', String(!isCollapsed));
			heading.addEventListener('click', () =>
			{
				const nowCollapsed = !collapsedHistoryUserIds.has(user.id);
				if (nowCollapsed)
				{
					collapsedHistoryUserIds.add(user.id);
					buildJourneys(getSelectedTrack(user)).forEach((journey) =>
					{
						collapsedHistoryJourneyKeys.add(getJourneyKey(user.id, journey));
					});
				} else
				{
					collapsedHistoryUserIds.delete(user.id);
				}
				renderTracks(trackUsers);
				renderTrackHistory(trackUsers);
			});

			const header = document.createElement('tr');
			[
				Homey.__('settings.map.historyCoordinates'),
				Homey.__('settings.map.historyTime'),
				Homey.__('settings.map.historySpeed'),
				Homey.__('settings.map.historyAccuracy'),
				Homey.__('settings.map.distance'),
				Homey.__('settings.map.impliedSpeed'),
			].forEach((label) =>
			{
				const cell = document.createElement('th');
				cell.textContent = label;
				header.appendChild(cell);
			});
			table.appendChild(header);
			const journeys = buildJourneys(points).slice().reverse();
			journeys.forEach((journey) =>
			{
				const journeyKey = getJourneyKey(user.id, journey);
				const isJourneyCollapsed = collapsedHistoryJourneyKeys.has(journeyKey);
				const summaryRow = document.createElement('tr');
				summaryRow.className = 'track-history-journey';
				const summary = document.createElement('td');
				summary.colSpan = 6;
				const destination = journey.points[journey.points.length - 1];
				const collapseButton = document.createElement('button');
				collapseButton.type = 'button';
				collapseButton.className = 'track-history-journey-toggle';
				collapseButton.setAttribute('aria-expanded', String(!isJourneyCollapsed));
				const collapseIcon = document.createElement('span');
				collapseIcon.className = 'track-history-collapse-icon';
				collapseIcon.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z"/></svg>';
				collapseIcon.classList.toggle('expanded', !isJourneyCollapsed);
				const summaryText = document.createElement('span');
				summaryText.textContent = `${new Date(journey.travelStart).toLocaleDateString()} | ${zoneAt(destination.lat, destination.lon) || `${destination.lat}, ${destination.lon}`} | ${formatJourneyAverageSpeed(journey)}`;
				collapseButton.append(collapseIcon, summaryText);
				collapseButton.addEventListener('click', () =>
				{
					if (collapsedHistoryJourneyKeys.has(journeyKey)) collapsedHistoryJourneyKeys.delete(journeyKey);
					else collapsedHistoryJourneyKeys.add(journeyKey);
					renderTracks(trackUsers);
					renderTrackHistory(trackUsers);
				});
				summary.appendChild(collapseButton);
				summaryRow.appendChild(summary);
				table.appendChild(summaryRow);

				if (isJourneyCollapsed) return;
				journey.points.slice().reverse().forEach((point, index, journeyPoints) =>
				{
					const speed = Number.isFinite(point.velocity)
						? `${(mapSpeedUnit === 'mph' ? point.velocity * 0.621371 : point.velocity).toFixed(1)} ${mapSpeedUnit === 'mph' ? 'mph' : 'km/h'}`
						: '-';
					const previous = journeyPoints[index + 1];
					const distance = previous ? calculateDistanceMeters(previous.lat, previous.lon, point.lat, point.lon) : null;
					const durationHours = previous ? (point.timestamp - previous.timestamp) / 3600000 : 0;
					const impliedSpeedKmh = Number.isFinite(distance) && durationHours > 0 ? distance / 1000 / durationHours : null;
					const impliedSpeed = impliedSpeedKmh === null
						? '-'
						: `${(mapSpeedUnit === 'mph' ? impliedSpeedKmh * 0.621371 : impliedSpeedKmh).toFixed(1)} ${mapSpeedUnit === 'mph' ? 'mph' : 'km/h'}`;
					const values = [
						`${point.lat}, ${point.lon}`,
						new Date(point.timestamp || Date.now()).toLocaleTimeString(),
						speed,
						Number.isFinite(point.accuracy) ? `${point.accuracy} m` : '-',
						Number.isFinite(distance) ? `${distance.toFixed(1)} m` : '-',
						impliedSpeed,
					];
					const row = document.createElement('tr');
					row.className = 'track-history-point';
					row.tabIndex = 0;
					const showPointOnMap = () =>
					{
						if (accuracyCircle)
						{
							accuracyCircle.remove();
						}
						accuracyCircle = null;
						if (typeof point.lat !== 'number' || typeof point.lon !== 'number') return;
						accuracyCircle = L.circle([point.lat, point.lon], {
							color: '#5BF527',
							fillColor: '#999',
							fillOpacity: 0.15,
							radius: Number(point.rad) || 100,
						}).addTo(trackMap);

						const marker = trackPointMarkers.get(point);
						// Inspecting a specific point holds the view there until a user is centred on.
						trackViewportPinned = true;
						lastProgrammaticTrackViewAt = Date.now();
						if (marker)
						{
							trackMap.panTo(marker.getLatLng());
							marker.openPopup();
							return;
						}

						// Closely-spaced points are deliberately omitted from the map to keep it readable,
						// but every logged row must still be inspectable.
						const popupContent = document.createElement('div');
						popupContent.textContent = `${user.name}\n${point.lat}, ${point.lon}\n${new Date(point.timestamp || Date.now()).toLocaleString()}`;
						popupContent.style.whiteSpace = 'pre-line';
						trackMap.panTo([point.lat, point.lon]);
						L.popup().setLatLng([point.lat, point.lon]).setContent(popupContent).openOn(trackMap);
					};
					row.addEventListener('click', showPointOnMap);
					row.addEventListener('keydown', (event) =>
					{
						if (event.key !== 'Enter' && event.key !== ' ') return;
						event.preventDefault();
						showPointOnMap();
					});
					values.forEach((value) =>
					{
						const cell = document.createElement('td');
						cell.textContent = value;
						row.appendChild(cell);
					});
					table.appendChild(row);
					trackHistoryRows.set(point, row);
				});
			});
			group.append(heading, table);
			historyList.appendChild(group);
		});
	}

	function loadTracks(preserveViewport = false)
	{
		Homey.api('GET', '/tracks', null, (err, users) =>
		{
			if (err || !Array.isArray(users)) return;
			const previousUserIds = new Set(trackUsers.map((user) => user.id));
			trackUsers = users;
			if (selectedTrackUserIds === null) selectedTrackUserIds = new Set(users.map((user) => user.id));
			else
			{
				const currentUserIds = new Set(users.map((user) => user.id));
				users.forEach((user) =>
				{
					if (!previousUserIds.has(user.id)) selectedTrackUserIds.add(user.id);
				});
				selectedTrackUserIds.forEach((userId) =>
				{
					if (!currentUserIds.has(userId)) selectedTrackUserIds.delete(userId);
				});
			}
			renderTrackFilter(users);
			renderJourneys();
			renderTracks(users, preserveViewport);
			renderTrackHistory(users);
		});
	}

	function loadTrackWaypoints()
	{
		Homey.api('GET', '/waypoints', null, (err, waypoints) =>
		{
			if (err || !Array.isArray(waypoints)) return;
			trackWaypoints = waypoints;
			if (trackMap) renderTrackZones();
		});
	}

	document.getElementById('toggleTrackHistory').addEventListener('click', (event) =>
	{
		const mapPanel = document.getElementById('tabPanelMap');
		const expanded = mapPanel.classList.toggle('history-expanded');
		event.currentTarget.textContent = Homey.__(expanded ? 'settings.map.hideHistory' : 'settings.map.showHistory');
		if (trackMap) setTimeout(() => trackMap.invalidateSize(), 100);
	});

	Homey.on('waypoints_updated', (waypoints) =>
	{
		trackWaypoints = Array.isArray(waypoints) ? waypoints : [];
		if (trackMap) renderTrackZones();
	});

	document.getElementById('openTrackFilter').addEventListener('click', () =>
	{
		document.getElementById('trackFilterModal').classList.remove('hidden');
		loadTracks();
	});

	const journeyGapInput = document.getElementById('journeyGapMinutes');
	Homey.get('journeyGapMinutes', (err, value) =>
	{
		if (!err && Number(value) >= 1)
		{
			journeyGapMinutes = Number(value);
			journeyGapInput.value = journeyGapMinutes;
		}
	});
	journeyGapInput.addEventListener('change', () =>
	{
		journeyGapMinutes = Math.min(999, Math.max(1, Math.round(Number(journeyGapInput.value) || 30)));
		journeyGapInput.value = journeyGapMinutes;
		selectedJourneys = [];
		Homey.set('journeyGapMinutes', journeyGapMinutes, (err) => { if (err) Homey.alert(err); });
		renderJourneys();
		renderTracks(trackUsers);
		renderTrackHistory(trackUsers);
	});

	Homey.get('trackPointStyle', (err, value) =>
	{
		if (!err && value === 'classic') trackPointStyle = 'classic';
	});

	const trackContextMenu = document.getElementById('trackContextMenu');
	const togglePointStyleMenuItem = document.getElementById('toggleTrackPointStyleMenuItem');
	const trackContextMenuUserItems = document.getElementById('trackContextMenuUserItems');
	const trackContextMenuContent = document.getElementById('trackContextMenuContent');
	const journeyPickerMenu = document.getElementById('journeyPickerMenu');
	const journeyPickerMenuTitle = document.getElementById('journeyPickerMenuTitle');
	const journeyPickerMenuList = document.getElementById('journeyPickerMenuList');
	let journeyPickerUserId = null;

	/** Rebuilt in place after each toggle so the menu stays open across several changes. */
	function renderTrackContextMenuItems()
	{
		togglePointStyleMenuItem.textContent = trackPointStyle === 'classic'
			? Homey.__('settings.map.useTeardropPoints')
			: Homey.__('settings.map.useClassicPoints');
		trackContextMenuContent.classList.remove('hidden');

		trackContextMenuUserItems.textContent = '';
		trackUsers.forEach((user) =>
		{
			const isVisible = selectedTrackUserIds === null || selectedTrackUserIds.has(user.id);
			const row = document.createElement('div');
			row.className = 'track-context-user-row';

			const visibilityButton = document.createElement('button');
			visibilityButton.type = 'button';
			visibilityButton.className = 'track-context-icon-button';
			visibilityButton.setAttribute('aria-label', Homey.__(isVisible ? 'settings.map.hideUser' : 'settings.map.showUser').replace('[[user]]', user.name));
			visibilityButton.innerHTML = isVisible
				? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5C21.27 7.61 17 4.5 12 4.5zm0 12.5c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>'
				: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.42-.08.65 0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01zM12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7z"/></svg>';
			visibilityButton.addEventListener('click', () =>
			{
				setTrackUserVisibility(user, !isVisible);
				renderTrackContextMenuItems();
			});

			const name = document.createElement('span');
			name.className = 'track-context-user-name';
			name.textContent = user.name;

			const journeysButton = document.createElement('button');
			journeysButton.type = 'button';
			if (isVisible)
			{
				journeysButton.className = 'track-context-icon-button';
				journeysButton.setAttribute('aria-label', Homey.__('settings.map.pickJourneys').replace('[[user]]', user.name));
				journeysButton.setAttribute('title', Homey.__('settings.map.pickJourneys').replace('[[user]]', user.name));
				journeysButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M23 8c0 1.1-.9 2-2 2-.18 0-.35-.02-.51-.07l-3.56 3.55c.05.16.07.34.07.52 0 1.1-.9 2-2 2s-2-.9-2-2c0-.18.02-.36.07-.52l-2.55-2.55c-.16.05-.34.07-.52.07s-.36-.02-.52-.07l-4.55 4.56c.05.16.07.33.07.51 0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2c.18 0 .35.02.51.07l4.56-4.55C8.02 9.36 8 9.18 8 9c0-1.1.9-2 2-2s2 .9 2 2c0 .18-.02.36-.07.52l2.55 2.55c.16-.05.34-.07.52-.07s.36.02.52.07l3.55-3.56C19.02 8.35 19 8.18 19 8c0-1.1.9-2 2-2s2 .9 2 2z"/></svg>';
				journeysButton.addEventListener('click', (event) =>
				{
					event.stopPropagation();
					const rect = journeysButton.getBoundingClientRect();
					openJourneyPicker(user.id, rect.left, rect.top);
				});
			} else
			{
				journeysButton.className = 'track-context-icon-button track-context-icon-placeholder';
				journeysButton.disabled = true;
				journeysButton.setAttribute('aria-hidden', 'true');
			}

			const canCenter = isVisible && user.lastLocation
				&& typeof user.lastLocation.lat === 'number' && typeof user.lastLocation.lon === 'number';
			const centerButton = document.createElement('button');
			centerButton.type = 'button';
			if (canCenter)
			{
				centerButton.className = 'track-context-icon-button';
				centerButton.setAttribute('aria-label', Homey.__('settings.map.centerOnUser').replace('[[user]]', user.name));
				centerButton.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3c-.46-4.17-3.77-7.48-7.94-7.94V1h-2v2.06C6.83 3.52 3.52 6.83 3.06 11H1v2h2.06c.46 4.17 3.77 7.48 7.94 7.94V23h2v-2.06c4.17-.46 7.48-3.77 7.94-7.94H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z"/></svg>';
				centerButton.addEventListener('click', () =>
				{
					centreTrackMapOn(user.lastLocation.lat, user.lastLocation.lon);
				});
			} else
			{
				centerButton.className = 'track-context-icon-button track-context-icon-placeholder';
				centerButton.disabled = true;
				centerButton.setAttribute('aria-hidden', 'true');
			}

			row.append(visibilityButton, name, journeysButton, centerButton);
			trackContextMenuUserItems.appendChild(row);
		});
	}

	function openJourneyPicker(userId, clientX, clientY)
	{
		journeyPickerUserId = userId;
		renderJourneyPickerMenu();
		hideTrackContextMenu();
		journeyPickerMenu.classList.remove('hidden');

		// Measured only once visible, so it can be clamped fully inside the viewport.
		const margin = 8;
		const rect = journeyPickerMenu.getBoundingClientRect();
		journeyPickerMenu.style.left = `${Math.max(margin, Math.min(clientX, window.innerWidth - rect.width - margin))}px`;
		journeyPickerMenu.style.top = `${Math.max(margin, Math.min(clientY, window.innerHeight - rect.height - margin))}px`;
	}

	function renderJourneyPickerMenu()
	{
		const user = trackUsers.find((item) => item.id === journeyPickerUserId);
		if (!user) return;

		journeyPickerMenuTitle.textContent = Homey.__('settings.map.journeysTitle').replace('[[user]]', user.name);
		journeyPickerMenuList.textContent = '';
		const journeys = buildJourneys(user.track);

		if (!journeys.length)
		{
			const empty = document.createElement('p');
			empty.className = 'journey-picker-empty';
			empty.textContent = Homey.__('settings.map.noJourneys');
			journeyPickerMenuList.appendChild(empty);
			return;
		}

		journeys.forEach((journey) =>
		{
			const row = document.createElement('label');
			row.className = 'journey-picker-row';
			const checkbox = document.createElement('input');
			checkbox.type = 'checkbox';
			checkbox.checked = isJourneySelected(user.id, journey.start, journey.end);
			checkbox.addEventListener('change', () =>
			{
				toggleJourneySelection({
					userId: user.id,
					start: journey.start,
					end: journey.end,
					travelStart: journey.travelStart,
					travelEnd: journey.travelEnd,
				});
				renderTrackMapTitle();
				renderTracks(trackUsers);
				renderTrackHistory(trackUsers);
			});

			const destination = journey.points[journey.points.length - 1];
			const zone = zoneAt(destination.lat, destination.lon);
			const start = new Date(journey.travelStart).toLocaleString([], {
				day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
			});
			const text = document.createElement('span');
			text.textContent = zone ? `${start} → ${zone}` : start;
			row.append(checkbox, text);
			journeyPickerMenuList.appendChild(row);
		});
	}

	function showTrackContextMenu(clientX, clientY)
	{
		renderTrackContextMenuItems();

		trackContextMenu.style.left = `${clientX}px`;
		trackContextMenu.style.top = `${clientY}px`;
		trackContextMenu.classList.remove('hidden');

		// Re-measure now that it's visible and clamp it fully inside the viewport,
		// since it can otherwise open partially off the edge of the screen.
		const margin = 8;
		const menuRect = trackContextMenu.getBoundingClientRect();
		const clampedLeft = Math.max(margin, Math.min(clientX, window.innerWidth - menuRect.width - margin));
		const clampedTop = Math.max(margin, Math.min(clientY, window.innerHeight - menuRect.height - margin));
		trackContextMenu.style.left = `${clampedLeft}px`;
		trackContextMenu.style.top = `${clampedTop}px`;
	}

	function hideTrackContextMenu()
	{
		trackContextMenu.classList.add('hidden');
	}

	togglePointStyleMenuItem.addEventListener('click', () =>
	{
		trackPointStyle = trackPointStyle === 'classic' ? 'teardrop' : 'classic';
		Homey.set('trackPointStyle', trackPointStyle, (err) => { if (err) Homey.alert(err); });
		renderTrackContextMenuItems();
		renderTracks(trackUsers, false, false);
	});

	const closeTrackContextMenuButton = document.getElementById('closeTrackContextMenu');
	closeTrackContextMenuButton.setAttribute('aria-label', Homey.__('settings.map.closeMenu'));
	closeTrackContextMenuButton.setAttribute('title', Homey.__('settings.map.closeMenu'));
	closeTrackContextMenuButton.addEventListener('click', hideTrackContextMenu);

	// Toggling an item rebuilds the menu, which detaches the clicked button before the
	// document handler runs - it would then see the click as coming from outside.
	trackContextMenu.addEventListener('click', (event) => event.stopPropagation());

	document.addEventListener('click', (event) =>
	{
		if (!trackContextMenu.classList.contains('hidden') && !trackContextMenu.contains(event.target)) hideTrackContextMenu();
	});

	const closeJourneyPickerButton = document.getElementById('closeJourneyPickerMenu');
	closeJourneyPickerButton.setAttribute('aria-label', Homey.__('settings.map.closeMenu'));
	closeJourneyPickerButton.setAttribute('title', Homey.__('settings.map.closeMenu'));
	closeJourneyPickerButton.addEventListener('click', () => journeyPickerMenu.classList.add('hidden'));

	journeyPickerMenu.addEventListener('click', (event) => event.stopPropagation());

	document.addEventListener('click', () => journeyPickerMenu.classList.add('hidden'));

	document.getElementById('closeJourneys').addEventListener('click', () =>
	{
		activeJourneyUserId = null;
		selectedJourneys = [];
		renderJourneys();
		renderTracks(trackUsers);
		renderTrackHistory(trackUsers);
	});

	document.querySelectorAll('[data-journey-sort]').forEach((button) =>
	{
		button.addEventListener('click', () =>
		{
			const column = button.dataset.journeySort;
			journeySort = {
				column,
				direction: journeySort.column === column && journeySort.direction === 'desc' ? 'asc' : 'desc',
			};
			renderJourneys();
		});
	});

	document.getElementById('copyTrackPoints').addEventListener('click', (event) =>
	{
		const user = trackUsers.find((item) => item.id === activeJourneyUserId);
		if (!user || !getDisplayedTrack(user).length)
		{
			Homey.alert(Homey.__('settings.map.noTrackPoints'));
			return;
		}

		const button = event.currentTarget;
		copyText(buildTrackPointsTsv(user)).then(() =>
		{
			const originalText = button.textContent;
			button.textContent = Homey.__('settings.map.trackPointsCopied');
			setTimeout(() => { button.textContent = originalText; }, 2000);
		}).catch(() => Homey.alert(Homey.__('settings.logs.copyFailed')));
	});

	document.querySelectorAll('.track-date-shortcut').forEach((button) =>
	{
		button.addEventListener('click', () => selectTrackDateShortcut(button.dataset.trackRange));
	});

	function applyCustomTrackDateRange()
	{
		const fromValue = document.getElementById('trackDateFrom').value;
		const toValue = document.getElementById('trackDateTo').value;
		const start = fromValue ? new Date(`${fromValue}T00:00:00`).getTime() : null;
		const inclusiveEnd = toValue ? new Date(`${toValue}T00:00:00`) : null;
		if (inclusiveEnd) inclusiveEnd.setDate(inclusiveEnd.getDate() + 1);
		trackDateRange = { start, end: inclusiveEnd ? inclusiveEnd.getTime() : null, shortcut: 'custom' };
		document.querySelectorAll('.track-date-shortcut').forEach((button) => button.classList.remove('active'));
		refreshTrackDateFilter();
	}

	document.getElementById('trackDateFrom').addEventListener('change', applyCustomTrackDateRange);
	document.getElementById('trackDateTo').addEventListener('change', applyCustomTrackDateRange);
	selectTrackDateShortcut('all', false);

	document.getElementById('closeTrackFilter').addEventListener('click', () =>
	{
		document.getElementById('trackFilterModal').classList.add('hidden');
	});

	// The app pushes this event whenever a user's position is recorded, so the map
	// refreshes live while this tab is open.
	Homey.on('tracks_updated', () =>
	{
		if (!document.getElementById('tabPanelMap').classList.contains('hidden'))
		{
			loadTracks(true);
		}
	});


	document.getElementById('cancelAddZone').addEventListener('click', () =>
	{
		editingZone = null;
		addZoneModal.classList.add('hidden');
	});

	document.getElementById('addZone').addEventListener('click', () =>
	{
		const zoneName = document.getElementById('zoneName');
		const zoneLat = document.getElementById('zoneLat');
		const zoneLon = document.getElementById('zoneLon');
		const zoneRadius = document.getElementById('zoneRadius');

		const waypoint = {
			desc: zoneName.value.trim(),
			lat: Number(zoneLat.value),
			lon: Number(zoneLon.value),
			rad: zoneRadius.value ? Number(zoneRadius.value) : 100,
		};

		if (!waypoint.desc || Number.isNaN(waypoint.lat) || Number.isNaN(waypoint.lon))
		{
			Homey.alert(Homey.__('settings.zones.fillInRequired'));
			return;
		}

		const scope = editingZone ? editingZone.scope : (activeZoneUserId ? 'private' : 'shared');
		const userId = editingZone ? editingZone.userId : activeZoneUserId;
		const request = editingZone
			? { id: editingZone.id, waypoint, scope, userId }
			: { waypoint, scope, userId };
		const path = editingZone ? '/waypoints/update' : '/waypoints';

		Homey.api('POST', path, request, (err) =>
		{
			if (err) return Homey.alert(err);
			editingZone = null;
			zoneName.value = '';
			zoneLat.value = '';
			zoneLon.value = '';
			zoneRadius.value = '';
			if (zoneMarker)
			{
				zoneMap.removeLayer(zoneMarker);
				zoneMap.removeLayer(zoneCircle);
				zoneMarker = null;
				zoneCircle = null;
			}
			addZoneModal.classList.add('hidden');
			loadZoneList();
		});
	});

	saveButton.addEventListener('click', async () =>
	{
		const connectionMethod = methodMqtt.checked ? 'mqtt' : 'http';
		const caCert = mqttCaCert.value.trim();

		if (connectionMethod === 'mqtt' && mqttUseTls.checked && caCert && !caCert.includes('-----BEGIN CERTIFICATE-----'))
		{
			return Homey.alert(Homey.__('settings.mqtt.caCertInvalid'));
		}

		const settings = [
			...(connectionMethod === 'http' ? [['connectionMethod', connectionMethod]] : []),
			['mqttBrokerUrl', mqttBrokerUrl.value],
			['mqttUseTls', mqttUseTls.checked],
			['mqttCaCert', caCert],
			['mqttAllowSelfSigned', mqttAllowSelfSigned.checked],
			['mqttPort', mqttPort.value ? Number(mqttPort.value) : null],
			['mqttUsername', mqttUsername.value],
			['mqttPassword', mqttPassword.value],
			...(connectionMethod === 'mqtt' ? [['connectionMethod', connectionMethod]] : []),
		];
		try
		{
			for (const [key, value] of settings)
			{
				await new Promise((resolve, reject) => Homey.set(key, value, (err) => err ? reject(err) : resolve()));
			}
			Homey.alert(Homey.__('settings.saved'));
		} catch (err)
		{
			Homey.alert(err);
		}
	});

	Homey.ready();
}
