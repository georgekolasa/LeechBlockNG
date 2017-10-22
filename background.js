/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const TICK_TIME = (1 / 60); // update every second

var OPTIONS = {};

var TABS = [];

var focusedWindowId = -1;

function log(message) { console.log("[LBNG] " + message); }
function warn(message) { console.warn("[LBNG] " + message); }

// Retrieves options from local storage
//
function retrieveOptions() {
	//log("retrieveOptions");

	browser.storage.local.get().then(onGot, onError);

	function onGot(options) {
		cleanOptions(options);
		cleanTimeData(options);
		//console.log(listObjectProperties(options, "options"));
		OPTIONS = options;
	}

	function onError(error) {
		warn("Cannot get options: " + error);
	}
}

// Saves time data to local storage
//
function saveTimeData() {
	//log("saveTimeData");

	let options = {};
	for (let set = 1; set <= NUM_SETS; set++) {
		options[`timedata${set}`] = OPTIONS[`timedata${set}`];
	}

	browser.storage.local.set(options);
}

// Updates ID of focused window
//
function updateFocusedWindowId() {
	browser.windows.getLastFocused().then(
		function (win) { focusedWindowId = win.id; },
		function (error) { warn("Cannot get focused window: " + error); }
	);
}

// Checks the URL of a tab and applies block if necessary (returns true if blocked)
//
function checkTab(id, url, isRepeat) {
	//log("checkTab: " + id + " " + url);

	if (!TABS[id] || !isRepeat) {
		TABS[id] = { url: url, blockable: false };
	}

	// Quick exit for non-http/non-file/non-about URLs
	if (!/^(http|file|about)/.test(url)) {
		return false; // not blocked
	}

	TABS[id].blockable = true;

	// Get parsed URL for this page
	let parsedURL = getParsedURL(url);

	// Get URL without hash part (unless it's a hash-bang part)
	let pageURL = parsedURL.page;
	if (parsedURL.hash != null && /^!/.test(parsedURL.hash)) {
		pageURL += "#" + parsedURL.hash;
	}

	// Get current time/date
	let timedate = new Date();

	// Get current time in seconds
	let now = Math.floor(Date.now() / 1000);

	TABS[id].secsLeft = Infinity;

	for (let set = 1; set <= NUM_SETS; set++) {
		// Get regular expressions for matching sites to block/allow
		let blockRE = OPTIONS[`blockRE${set}`];
		if (blockRE == "") continue; // no block for this set
		let allowRE = OPTIONS[`allowRE${set}`];
		let keywordRE = OPTIONS[`keywordRE${set}`];

		// Get options for preventing access to about:addons and about:config
		let prevAddons = OPTIONS[`prevAddons${set}`];
		let prevConfig = OPTIONS[`prevConfig${set}`];

		// Test URL against block/allow regular expressions
		if (testURL(pageURL, blockRE, allowRE)
				|| (prevAddons && /^about:addons/i.test(pageURL))
				|| (prevConfig && /^about:(config|support)/i.test(pageURL))) {
			// Get options for this set
			let timedata = OPTIONS[`timedata${set}`];
			let times = OPTIONS[`times${set}`];
			let minPeriods = getMinPeriods(times);
			let limitMins = OPTIONS[`limitMins${set}`];
			let limitPeriod = OPTIONS[`limitPeriod${set}`];
			let periodStart = getTimePeriodStart(now, limitPeriod);
			let conjMode = OPTIONS[`conjMode${set}`];
			let days = OPTIONS[`days${set}`];
			let blockURL = OPTIONS[`blockURL${set}`];
			let activeBlock = OPTIONS[`activeBlock${set}`];

			// Check day
			let onSelectedDay = days[timedate.getDay()];

			// Check time periods
			let secsLeftBeforePeriod = Infinity;
			if (onSelectedDay && times != "") {
				// Get number of minutes elapsed since midnight
				let mins = timedate.getHours() * 60 + timedate.getMinutes();

				// Check each time period in turn
				for (let mp of minPeriods) {
					if (mins >= mp.start && mins < mp.end) {
						secsLeftBeforePeriod = 0;
					} else if (mins < mp.start) {
						// Compute exact seconds before this time period starts
						let secs = (mp.start - mins) * 60 - timedate.getSeconds();
						if (secs < secsLeftBeforePeriod) {
							secsLeftBeforePeriod = secs;
						}
					}
				}
			}

			// Check time limit
			let secsLeftBeforeLimit = Infinity;
			if (onSelectedDay && limitMins != "" && limitPeriod != "") {
				// Compute exact seconds before this time limit expires
				secsLeftBeforeLimit = limitMins * 60;
				if (timedata[2] == periodStart) {
					let secs = secsLeftBeforeLimit - timedata[3];
					secsLeftBeforeLimit = Math.max(0, secs);
				}
			}

			let withinTimePeriods = (secsLeftBeforePeriod == 0);
			let afterTimeLimit = (secsLeftBeforeLimit == 0);

			// Check lockdown condition
			let lockdown = (timedata[4] > now);

			// Check for keywords
			//let keywords = (keywordRE == "") || checkKeywords(doc, keywordRE);
			let keywords = true;

			// Determine whether this page should now be blocked
			let doBlock = lockdown
					|| (!conjMode && (withinTimePeriods || afterTimeLimit) && keywords)
					|| (conjMode && (withinTimePeriods && afterTimeLimit) && keywords);

			// Redirect page if all relevant block conditions are fulfilled
			if (doBlock && (!isRepeat || activeBlock)) {
				// Get final URL for block page
				blockURL = blockURL.replace(/\$S/g, set).replace(/\$U/g, pageURL);

				// Redirect page
				browser.tabs.update(id, {url: blockURL});

				return true; // blocked
			}

			// Update seconds left before block
			let secsLeft = conjMode
					? (secsLeftBeforePeriod + secsLeftBeforeLimit)
					: Math.min(secsLeftBeforePeriod, secsLeftBeforeLimit);
			if (secsLeft < TABS[id].secsLeft) {
				TABS[id].secsLeft = secsLeft;
				TABS[id].secsLeftSet = set;
			}
		}
	}

	return false; // not blocked
}

// Clocks time spent on page
//
function clockPageTime(id, open, focus) {
	if (!TABS[id] || !TABS[id].blockable) {
		return;
	}

	// Get current time in milliseconds
	let time = Date.now();

	// Clock time during which page has been open
	let secsOpen = 0;
	if (open) {
		if (TABS[id].openTime == undefined) {
			// Set open time for this page
			TABS[id].openTime = time;
		}
	} else {
		if (TABS[id].openTime != undefined) {
			if (/^(http|file)/.test(TABS[id].url)) {
				// Calculate seconds spent on this page (while open)
				secsOpen = ((time - TABS[id].openTime) / 1000);
			}

			TABS[id].openTime = undefined;
		}
	}

	// Clock time during which page has been focused
	let secsFocus = 0;
	if (focus) {
		if (TABS[id].focusTime == undefined) {
			// Set focus time for this page
			TABS[id].focusTime = time;
		}
	} else {
		if (TABS[id].focusTime != undefined) {
			if (/^(http|file)/.test(TABS[id].url)) {
				// Calculate seconds spent on this page (while focused)
				secsFocus = ((time - TABS[id].focusTime) / 1000);
			}

			TABS[id].focusTime = undefined;
		}
	}

	// Update time data if necessary
	if (secsOpen > 0 || secsFocus > 0) {
		updateTimeData(TABS[id].url, secsOpen, secsFocus);
	}
}

// Updates time data for specified page
//
function updateTimeData(url, secsOpen, secsFocus) {
	//log("updateTimeData: " + url + " " + secsOpen + " " + secsFocus);

	// Get parsed URL for this page
	let parsedURL = getParsedURL(url);
	let pageURL = parsedURL.page;

	// Get current time/date
	let timedate = new Date();

	// Get current time in seconds
	let now = Math.floor(Date.now() / 1000);

	for (let set = 1; set <= NUM_SETS; set++) {
		// Get regular expressions for matching sites to block/allow
		let blockRE = OPTIONS[`blockRE${set}`];
		if (blockRE == "") continue; // no block for this set
		let allowRE = OPTIONS[`allowRE${set}`];

		// Test URL against block/allow regular expressions
		if (testURL(pageURL, blockRE, allowRE)) {
			// Get options for this set
			let timedata = OPTIONS[`timedata${set}`];
			let countFocus = OPTIONS[`countFocus${set}`];
			let times = OPTIONS[`times${set}`];
			let minPeriods = getMinPeriods(times);
			let limitPeriod = OPTIONS[`limitPeriod${set}`];
			let periodStart = getTimePeriodStart(now, limitPeriod);
			let conjMode = OPTIONS[`conjMode${set}`];
			let days = OPTIONS[`days${set}`];

			/*
			// Avoid over-counting time when multiple documents loaded
			if (!countFocus && !LeechBlock.isActiveLoadedDoc(set, doc)) continue;
			*/

			// Reset time data if currently invalid
			if (!Array.isArray(timedata) || timedata.length != 5) {
				timedata = [now, 0, 0, 0, 0];
			}

			// Get number of seconds spent on page (focused or open)
			let secsSpent = countFocus ? secsFocus : secsOpen;

			// Update data for total time spent
			timedata[1] = +timedata[1] + secsSpent;

			// Determine whether we should count time spent on page in
			// specified time period (we should only count time on selected
			// days -- and in conjunction mode, only within time periods)
			let countTimeSpentInPeriod = days[timedate.getDay()];
			if (countTimeSpentInPeriod && conjMode) {
				countTimeSpentInPeriod = false;

				// Get number of minutes elapsed since midnight
				let mins = timedate.getHours() * 60 + timedate.getMinutes();

				// Check each time period in turn
				for (let mp of minPeriods) {
					if (mins >= mp.start && mins < mp.end) {
						countTimeSpentInPeriod = true;
					}
				}
			}

			// Update data for time spent in specified time period
			if (countTimeSpentInPeriod && periodStart > 0 && timedata[2] >= 0) {
				if (timedata[2] != periodStart) {
					// We've entered a new time period, so start new count
					timedata[2] = periodStart;
					timedata[3] = secsSpent;
				} else {
					// We haven't entered a new time period, so keep counting
					timedata[3] = +timedata[3] + secsSpent;
				}
			}

			// Update time data for this set
			OPTIONS[`timedata${set}`] = timedata;
		}
	}
}

// Updates time left widget
//
function updateTimeLeftWidget(id) {
	if (!TABS[id] || !TABS[id].blockable || /^about/.test(TABS[id].url)) {
		return;
	}

	// Send message to tab
	let secsLeft = TABS[id].secsLeft;
	let message = { type: "timeleft" };
	if (secsLeft == undefined || secsLeft == Infinity) {
		message.content = null; // hide widget
	} else {
		message.content = formatTime(secsLeft); // show widget with time left
	}
	browser.tabs.sendMessage(id, message);
}

// Creates info for blocking/delaying page
//
function createBlockInfo(url) {
	// Get parsed URL
	let parsedURL = getParsedURL(url);
	let pageURL = parsedURL.page;

	if (parsedURL.args == null || parsedURL.args.length < 2) {
		warn("Cannot create block info: not enough arguments in URL.");
		return {};
	}

	// Get block set and URL (including hash part) of blocked page
	let blockedSet = parsedURL.args.shift();
	let blockedSetName = OPTIONS[`setName${blockedSet}`];
	let blockedURL = parsedURL.query.substring(3); // retains original separators (& or ;)
	if (parsedURL.hash != null) {
		blockedURL += "#" + parsedURL.hash;
	}

	// Get unblock time for block set
	let unblockTime = getUnblockTime(blockedSet);
	if (unblockTime != null) {
		// Convert to string
		if (unblockTime.getDate() == new Date().getDate()) {
			// Same day: show time only
			unblockTime = unblockTime.toLocaleTimeString();
		} else {
			// Different day: show date and time
			unblockTime = unblockTime.toLocaleString();
		}
	}

	return {
		blockedSet: blockedSet,
		blockedSetName: blockedSetName,
		blockedURL: blockedURL,
		unblockTime: unblockTime
	};
}

// Returns time when blocked sites will be unblocked (as Date object)
//
function getUnblockTime(set) {
	// Check for invalid set number
	if (set < 1 || set > NUM_SETS) {
		return null;
	}

	// Get current time/date
	let timedate = new Date();
	
	// Get current time in seconds
	let now = Math.floor(Date.now() / 1000);

	// Get options for this set
	let timedata = OPTIONS[`timedata${set}`];
	let times = OPTIONS[`times${set}`];
	let minPeriods = getMinPeriods(times);
	let limitMins = OPTIONS[`limitMins${set}`];
	let limitPeriod = OPTIONS[`limitPeriod${set}`];
	let periodStart = getTimePeriodStart(now, limitPeriod);
	let conjMode = OPTIONS[`conjMode${set}`];
	let days = OPTIONS[`days${set}`];

	// Check for valid time data
	if (!Array.isArray(timedata) || timedata.length != 5) {
		return null;
	}

	// Check for 24/7 block
	if (times == ALL_DAY_TIMES && allTrue(days) && !conjMode) {
		return null;
	}

	// Check for lockdown
	if (now < timedata[4]) {
		// Return end time for lockdown
		return new Date(timedata[4] * 1000);
	}
	
	// Get number of minutes elapsed since midnight
	let mins = timedate.getHours() * 60 + timedate.getMinutes();

	// Create list of time periods for today and following seven days
	let day = timedate.getDay();
	let allMinPeriods = [];
	for (let i = 0; i <= 7; i++) {
		if (days[(day + i) % 7]) {
			let offset = (i * 1440);
			for (let mp of minPeriods) {
				// Create new time period with offset
				let mp1 = {
					start: (mp.start + offset),
					end: (mp.end + offset)
				};
				if (allMinPeriods.length == 0) {
					// Add new time period
					allMinPeriods.push(mp1);
				} else {
					let mp0 = allMinPeriods[allMinPeriods.length - 1];
					if (mp1.start <= mp0.end) {
						// Merge time period into previous one
						mp0.end = mp1.end;
					} else {
						// Add new time period
						allMinPeriods.push(mp1);
					}
				}
			}
		}
	}

	let timePeriods = (times != "");
	let timeLimit = (limitMins != "" && limitPeriod != "");

	if (timePeriods && !timeLimit) {
		// Case 1: within time periods (no time limit)

		// Find relevant time period
		for (let mp of allMinPeriods) {
			if (mins >= mp.start && mins < mp.end) {
				// Return end time for time period
				return new Date(
						timedate.getFullYear(),
						timedate.getMonth(),
						timedate.getDate(),
						0, mp.end);
			}
		}
	} else if (!timePeriods && timeLimit) {
		// Case 2: after time limit (no time periods)

		// Return end time for current time limit period
		return new Date(timedata[2] * 1000 + limitPeriod * 1000);
	} else if (timePeriods && timeLimit) {
		if (conjMode) {
			// Case 3: within time periods AND after time limit

			// Find relevant time period
			for (let mp of allMinPeriods) {
				if (mins >= mp.start && mins < mp.end) {
					// Return the earlier of the two end times
					let td1 = new Date(
							timedate.getFullYear(),
							timedate.getMonth(),
							timedate.getDate(),
							0, mp.end);
					let td2 = new Date(timedata[2] * 1000 + limitPeriod * 1000);
					return (td1 < td2) ? td1 : td2;
				}
			}
		} else {
			// Case 4: within time periods OR after time limit

			// Determine whether time limit was exceeded
			let afterTimeLimit = (timedata[2] == periodStart)
					&& (timedata[3] >= (limitMins * 60));

			if (afterTimeLimit) {
				// Check against end time for current time limit period instead
				let td = new Date(timedata[2] * 1000 + limitPeriod * 1000);
				mins = td.getHours() * 60 + td.getMinutes();
			}

			// Find relevant time period
			for (let mp of allMinPeriods) {
				if (mins >= mp.start && mins < mp.end) {
					// Return end time for time period
					return new Date(
							timedate.getFullYear(),
							timedate.getMonth(),
							timedate.getDate(),
							0, mp.end);
				}
			}
		}
	}

	return null;
}

/*** EVENT HANDLERS BEGIN HERE ***/

function handleMessage(message, sender, sendResponse) {
	if (!sender) {
		warn("No sender!");
		return;
	}

	//log("handleMessage: " + sender.tab.id + " " + sender.url);

	if (message.type == "options") {
		retrieveOptions();
	} else if (message.type == "blocked") {
		let info = createBlockInfo(sender.url);
		sendResponse(info);
	}
}

function handleTabCreated(tab) {
	//log("handleTabCreated: " + tab.id);
}

function handleTabUpdated(tabId, changeInfo, tab) {
	//log("handleTabUpdated: " + tabId);
	//console.log(listObjectProperties(changeInfo, "changeInfo"));

	let isFocused = (tab.active && tab.windowId == focusedWindowId);

	if (changeInfo.status && changeInfo.status == "complete") {
		clockPageTime(tabId, true, isFocused);
		updateTimeLeftWidget(tabId);
	}
}

function handleTabActivated(activeInfo) {
	//log("handleTabActivated: " + activeInfo.tabId);

	let isFocused = (activeInfo.windowId == focusedWindowId);

	clockPageTime(activeInfo.tabId, true, isFocused);
	updateTimeLeftWidget(activeInfo.tabId);
}

function handleTabRemoved(tabId, removeInfo) {
	//log("handleTabRemoved: " + tabId);

	clockPageTime(tabId, false, false);
}

function handleBeforeNavigate(navDetails) {
	//log("handleBeforeNavigate: " + navDetails.tabId);

	clockPageTime(navDetails.tabId, false, false);

	if (navDetails.frameId == 0) {
		let blocked = checkTab(navDetails.tabId, navDetails.url, false);
	}
}

function handleWinFocused(winId) {
	//log("handleWinFocused: " + winId);

	focusedWindowId = winId;
}

function handleAlarm(alarm) {
	//log("handleAlarm: " + alarm.name);

	browser.tabs.query({}).then(onGot, onError);

	function onGot(tabs) {
		// Process all tabs
		for (let tab of tabs) {
			let isFocused = (tab.active && tab.windowId == focusedWindowId);

			// Force update of time spent on this page
			clockPageTime(tab.id, false, false);
			clockPageTime(tab.id, true, isFocused);

			let blocked = checkTab(tab.id, tab.url, true);

			if (!blocked) {
				updateTimeLeftWidget(tab.id);
			}
		}

		// Save time data to local storage
		saveTimeData();
	}

	function onError(error) {
		warn("Cannot get tabs: " + error);
	}
}

/*** STARTUP CODE BEGINS HERE ***/

retrieveOptions();

browser.runtime.onMessage.addListener(handleMessage);

//browser.tabs.onCreated.addListener(handleTabCreated);
browser.tabs.onUpdated.addListener(handleTabUpdated);
browser.tabs.onActivated.addListener(handleTabActivated);
browser.tabs.onRemoved.addListener(handleTabRemoved);

browser.webNavigation.onBeforeNavigate.addListener(handleBeforeNavigate);

browser.windows.onFocusChanged.addListener(handleWinFocused);

browser.alarms.onAlarm.addListener(handleAlarm);
browser.alarms.create("LBNG", { periodInMinutes: TICK_TIME });