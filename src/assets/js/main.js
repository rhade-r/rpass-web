/*****************************************************
 This file is part of rpass.

    rpass is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    rpass is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with rpass.  If not, see <https://www.gnu.org/licenses/>.

	Home: https://github.com/Rhade-R/rpass-web

*******************************************************/

'use strict';

const cr = `\u00A9 ${new Date().getFullYear()} Rhade`;
const ui = document.getElementsByTagName('*');

const ALG_HINTS = {
	v1: 'v1 (legacy): 50 printable ASCII characters, may include spaces.',
	v2: 'v2: 32 characters from A-Z a-z 0-9 and !@#$%^&*()-_=+ (no spaces).'
};

let pw = null;
let algorithm = 'v1';
let importedStored = null;   // outer StoredVault (has _v_)
let importedVault = null;    // decrypted payload
let busy = false;
let resetTimer = null;
let generateStatusShown = false;
let secret = '';           // master password while the on-screen keyboard is in use
let keyboardMode = false;  // true: the master password lives in `secret`, not in the page

// This script is loaded at the end of <body>, so the DOM is ready.
ui.copyright.textContent = cr;
document.getElementsByTagName('footer')[0].hidden = false;

function setLabel(text) {
	ui.generate.firstElementChild.textContent = text;
}

function say(message, isError, fromGenerate) {
	ui.status.textContent = message;
	ui.status.classList.toggle('error', !!isError);
	generateStatusShown = !!fromGenerate && message !== '';
}

function isDone() {
	return ui.generate.classList.contains('done');
}

// Everything a derivation depends on, normalised the way derive.js does.
function inputKey() {
	return [
		getMasterPassword(),
		RpassDerive.normalizeIdentifier(ui.service.value),
		RpassDerive.normalizeIdentifier(ui.user.value),
		RpassDerive.normalizeIter(ui.iter.value),
		algorithm
	].join('\u0000');
}

// Any edit invalidates a finished result.  While a derivation is running
// its result is checked against inputKey() when it completes instead.
function clearDone() {
	if (busy) return;
	clearTimeout(resetTimer);
	pw = null;
	ui.generate.classList.remove('done');
	setLabel('Generate');
	if (generateStatusShown) say('');
}

function setAlgorithm(next) {
	if (next === algorithm) return;
	algorithm = next;
	ui.algorithm.textContent = algorithm;
	ui.algorithm.classList.toggle('v2', algorithm === 'v2');
	ui.algorithm.setAttribute('aria-label', 'Algorithm ' + algorithm + ' (click to switch)');
	ui['alg-hint'].textContent = ALG_HINTS[algorithm];
	clearDone();
}

ui.algorithm.addEventListener('click', function (e) {
	setAlgorithm(algorithm === 'v1' ? 'v2' : 'v1');
});

ui['toggle-mp'].addEventListener('click', function (e) {
	const reveal = ui.mp.type === 'password';
	ui.mp.type = reveal ? 'text' : 'password';
	this.textContent = reveal ? 'hide' : 'show';
});

// A real <form>: the browser validates the `required` fields, and this
// fires for a click, the Enter key, and keyboard activation of the button.
ui.main.addEventListener('submit', function (e) {
	e.preventDefault();
	if (busy) return;
	if (isDone()) {
		copyPassword();
		return;
	}

	// A read-only field (on-screen keyboard open) is exempt from the
	// browser's `required` check, so check here as well.
	if (!getMasterPassword()) {
		say('Enter your master password first.', true);
		return;
	}

	busy = true;
	const startKey = inputKey();
	ui.generate.disabled = true;
	ui.generate.setAttribute('aria-label', 'Generating');
	setLabel('');
	say('Generating\u2026', false, true);

	RpassDerive.derive(
		getMasterPassword(),
		ui.service.value,
		ui.user.value,
		ui.iter.value,
		algorithm,
		function (derived) {
			busy = false;
			ui.generate.disabled = false;
			ui.generate.removeAttribute('aria-label');
			if (!document.activeElement || document.activeElement === document.body) {
				ui.generate.focus();
			}
			if (inputKey() !== startKey) {
				setLabel('Generate');
				say('Inputs changed while generating. Press Generate again.', true, true);
				return;
			}
			pw = derived;
			ui.generate.classList.add('done');
			setLabel('Copy to clipboard');
			say('Password ready. Press the button to copy it.', false, true);
		}
	);
});

function copyPassword() {
	clearTimeout(resetTimer);
	copyText(pw)
		.then(
			function () {
				setLabel('Copied!');
				say('Copied to clipboard.', false, true);
			},
			function () {
				setLabel('Copy failed');
				say('Could not write to the clipboard. Check this page\u2019s clipboard permission in your browser.', true, true);
			}
		)
		.then(function () {
			resetTimer = setTimeout(function () {
				if (isDone()) setLabel('Copy to clipboard');
			}, 2000);
		});
}

ui.mp.addEventListener('change', clearDone);
ui.mp.addEventListener('input', clearDone);

ui.service.addEventListener('input', function () {
	clearDone();
	updateMigrationBadge();
});
ui.service.addEventListener('change', function () {
	this.value = RpassDerive.normalizeIdentifier(this.value);
	clearDone();
	maybeAutofillFromImport();
	updateMigrationBadge();
});

ui.user.addEventListener('input', function () {
	clearDone();
	updateMigrationBadge();
});
ui.user.addEventListener('change', function () {
	this.value = RpassDerive.normalizeIdentifier(this.value);
	clearDone();
	maybeAutofillIter();
	updateMigrationBadge();
});

ui.iter.addEventListener('input', function () {
	clearDone();
	updateMigrationBadge();
});
ui.iter.addEventListener('change', function () {
	this.value = RpassDerive.normalizeIter(this.value);
	clearDone();
	updateMigrationBadge();
});

// --- on-screen keyboard -------------------------------------------------
//
// An optional in-page keyboard for entering the master password on a device
// whose physical keyboard, or browser extensions, you do not trust.
//
//  * The keys are drawn on a <canvas>.  No element, text, class or attribute
//    names a key's character or colour, and the typed characters are kept in
//    the `secret` variable, not in an input: the master password field shows
//    only bullets.  An extension's content script shares the page's DOM but
//    not its JavaScript variables, so it cannot read the password from here.
//  * Every cell carries a coordinate label (column letter then row number,
//    like "B3" or "J10"). The coordinate is shown in both states: centred
//    when the keys are hidden, small in a corner when they are visible. A
//    user who peeks can write a coordinate down or hold it in mind and
//    type it later without another peek.
//  * A cell whose character is already part of the master password gets a
//    pick indicator (a translucent fill and a thick inner border), so a
//    character that appears more than once can be found again at a glance.
//  * Keys are hidden by default and a press on a hidden key types it.
//    "Peek" shows the keys after OSK_REVEAL_DELAY_MS for OSK_PEEK_MS.
//    While the keys are visible, ANY input event -- a pointer press
//    anywhere, or a printable / Enter / Backspace key press -- reshuffles
//    the layout, hides the labels for another OSK_REVEAL_DELAY_MS, and
//    adds OSK_EXTEND_MS, capped at OSK_MAX_VISIBLE_MS per continuous
//    reveal. This is the point: the defence against a screenshot taken on
//    click is that no click ever happens while a stable mapping from
//    coordinates to characters is on screen. The layout is shuffled when
//    the keyboard opens (unless a password is already partly typed) and
//    on every such input event.
//  * A press is judged by the state when it begins, and a reveal is held
//    back while any press is in progress.  There is no "hide now" button:
//    it would be a press made while the labels are visible.
//
// This does NOT defend against malware that records the screen (a capture
// during a peek plus later click positions decodes everything), a script
// running in the page's own world, or clipboard access.  ASCII only.

const OSK_COLS = 10;
const OSK_PEEK_MS = 10000;
const OSK_EXTEND_MS = 10000;
const OSK_MAX_VISIBLE_MS = 60000;
const OSK_REVEAL_DELAY_MS = 400;
const OSK_SETTLE_MS = 150;

const OSK_CHARS = Array.from({ length: 95 }, function (_, i) {
	return String.fromCharCode(32 + i);
});

// Letters by English frequency (Lewand), most common first, 3-4 per colour.
// Okabe-Ito palette plus white, brightest = most common; all >= 5.4:1 on black.
const OSK_LETTER_GROUPS = ['eta', 'oin', 'shrd', 'lcum', 'wfgy', 'pbvk', 'jxqz'];
const OSK_GROUP_COLORS = ['#FFFFFF', '#F0E442', '#E69F00', '#56B4E9', '#CC79A7', '#009E73', '#D55E00'];
const OSK_OTHER_COLOR = '#999999';
const OSK_BORDER_COLOR = '#6699CC';
// Pick indicator for cells whose character is already in `secret`.
// Cyan is not used by any OSK_LETTER_GROUPS entry, so it never
// collides with a character's own colour.
const OSK_PICKED_COLOR = '#00E5FF';
const OSK_PICKED_FILL = 'rgba(0, 229, 255, 0.25)';
const OSK_PICKED_STROKE_WIDTH = 3;

let oskState = 'hidden'; // 'hidden' | 'revealing' | 'visible'
let oskLayout = [];
let oskHiddenAt = -Infinity;
let oskVisibleSince = 0;
let oskDeadline = 0;
let oskHideTimer = null;
let oskRevealTimer = null;
let oskTickTimer = null;
let oskPress = null; // { pointerId, index, kind: 'type' | 'burn' | 'ignore' }

// Unbiased random integer in [0, n).
function randomInt(n) {
	const limit = Math.floor(0x100000000 / n) * n;
	const buf = new Uint32Array(1);
	let x;
	do {
		crypto.getRandomValues(buf);
		x = buf[0];
	} while (x >= limit);
	return x % n;
}

function shuffleInPlace(a) {
	for (let i = a.length - 1; i > 0; i--) {
		const j = randomInt(i + 1);
		const t = a[i];
		a[i] = a[j];
		a[j] = t;
	}
	return a;
}

function keyColor(c) {
	const lower = c.toLowerCase();
	for (let i = 0; i < OSK_LETTER_GROUPS.length; i++) {
		if (OSK_LETTER_GROUPS[i].indexOf(lower) !== -1) return OSK_GROUP_COLORS[i];
	}
	return OSK_OTHER_COLOR;
}

// Cell coordinate, like "B3" or "J10": column letter then row number,
// left to right and top to bottom, both starting at 1. Not a secret
// (it names a position, not a character), but stable for the session,
// so a user can write it down or hold it in mind between a peek and
// a press.
function cellName(index) {
	const col = index % OSK_COLS;
	const row = Math.floor(index / OSK_COLS);
	return String.fromCharCode(65 + col) + String(row + 1);
}

// --- where the master password lives ---

function getMasterPassword() {
	return keyboardMode ? secret : ui.mp.value;
}

function setSecret(value) {
	secret = value;
	ui.mp.value = '\u2022'.repeat(Array.from(secret).length);
	clearDone();
}

function enterKeyboardMode() {
	keyboardMode = true;
	secret = '';
	ui.mp.value = '';
	ui.mp.type = 'text';
	ui.mp.readOnly = true;
	ui.mp.title = 'Filled with the on-screen keyboard. Open the keyboard to edit.';
	ui['toggle-mp'].textContent = 'show';
	ui['toggle-mp'].disabled = true;
	clearDone();
	say('Keyboard mode: the master password is kept in memory, not in the page.');
}

function leaveKeyboardMode() {
	keyboardMode = false;
	secret = '';
	ui.mp.value = '';
	ui.mp.type = 'password';
	ui.mp.readOnly = false;
	ui.mp.removeAttribute('title');
	ui['toggle-mp'].disabled = false;
	clearDone();
}

// --- drawing and hit-testing ---

function renderOsk() {
	const canvas = ui['osk-canvas'];
	const side = Math.floor(canvas.getBoundingClientRect().width);
	if (side <= 0) return;
	const dpr = window.devicePixelRatio || 1;
	const px = Math.round(side * dpr);
	canvas.style.height = side + 'px';
	if (canvas.width !== px || canvas.height !== px) {
		canvas.width = px;
		canvas.height = px;
	}
	const ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, side, side);
	const cell = side / OSK_COLS;
	const show = oskState === 'visible';
	// Characters already in `secret`. A Set, not a count: the marker
	// answers "has this character been used", so a repeat is found
	// again without tracking how many times it has been pressed.
	const picked = new Set(secret);
	ctx.textAlign = 'center';
	ctx.textBaseline = 'middle';
	oskLayout.forEach(function (c, index) {
		const x = (index % OSK_COLS) * cell;
		const y = Math.floor(index / OSK_COLS) * cell;
		const isPicked = picked.has(c);

		// Pick indicator fill, behind the character.
		if (isPicked) {
			ctx.fillStyle = OSK_PICKED_FILL;
			ctx.fillRect(x + 1.5, y + 1.5, cell - 3, cell - 3);
		}

		// Outer cell border.
		ctx.strokeStyle = OSK_BORDER_COLOR;
		ctx.lineWidth = 1;
		ctx.strokeRect(x + 1.5, y + 1.5, cell - 3, cell - 3);

		// Pick indicator: thick inner stroke.
		if (isPicked) {
			const inset = OSK_PICKED_STROKE_WIDTH + 1.5;
			ctx.strokeStyle = OSK_PICKED_COLOR;
			ctx.lineWidth = OSK_PICKED_STROKE_WIDTH;
			ctx.strokeRect(x + inset, y + inset, cell - 2 * inset, cell - 2 * inset);
		}

		if (show) {
			const label = c === ' ' ? 'space' : c;
			ctx.font = 'bold ' + (c === ' ' ? Math.floor(cell * 0.28) : Math.floor(cell * 0.5)) +
				'px Hack, Consolas, monospace';
			ctx.fillStyle = keyColor(c);
			ctx.fillText(label, x + cell / 2, y + cell / 2);

			// Coordinate, small, top-right corner.
			ctx.font = Math.floor(cell * 0.22) + 'px Hack, Consolas, monospace';
			ctx.fillStyle = '#BBB';
			ctx.textAlign = 'right';
			ctx.textBaseline = 'top';
			ctx.fillText(cellName(index), x + cell - 4, y + 4);
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
		} else {
			// Hidden: coordinate centred, no character.
			ctx.font = 'bold ' + Math.floor(cell * 0.4) + 'px Hack, Consolas, monospace';
			ctx.fillStyle = '#BBB';
			ctx.fillText(cellName(index), x + cell / 2, y + cell / 2);
		}
	});
}

function oskCell(e) {
	const rect = ui['osk-canvas'].getBoundingClientRect();
	if (!rect.width) return -1;
	const size = rect.width / OSK_COLS;
	const col = Math.floor((e.clientX - rect.left) / size);
	const row = Math.floor((e.clientY - rect.top) / size);
	if (col < 0 || col >= OSK_COLS || row < 0) return -1;
	const index = row * OSK_COLS + col;
	return index < oskLayout.length ? index : -1;
}

function updateOskState() {
	const visible = oskState === 'visible';
	ui['osk-canvas'].classList.toggle('visible', visible);
	ui['osk-state'].classList.toggle('visible', visible);
	if (visible) {
		const s = Math.max(0, Math.ceil((oskDeadline - Date.now()) / 1000));
		ui['osk-state'].textContent = 'KEYS VISIBLE (' + s + ' s): any tap or key reshuffles the keys and adds ' +
			OSK_EXTEND_MS / 1000 + ' s.';
	} else if (oskState === 'revealing') {
		ui['osk-state'].textContent = 'Showing keys\u2026';
	} else {
		ui['osk-state'].textContent = 'Keys hidden: presses type. Press peek to see them.';
	}
}

// --- visibility state machine ---

function oskStopTimers() {
	clearTimeout(oskHideTimer);
	clearTimeout(oskRevealTimer);
	clearInterval(oskTickTimer);
	oskHideTimer = null;
	oskRevealTimer = null;
	oskTickTimer = null;
}

function oskScheduleHide() {
	clearTimeout(oskHideTimer);
	oskHideTimer = setTimeout(oskHide, Math.max(0, oskDeadline - Date.now()));
}

function oskHide() {
	oskStopTimers();
	oskState = 'hidden';
	oskHiddenAt = Date.now();
	renderOsk();
	updateOskState();
}

function oskReveal(resume) {
	if (oskPress) {
		// Never bring the labels up under a finger.
		oskRevealTimer = setTimeout(function () { oskReveal(resume); }, 50);
		return;
	}
	const now = Date.now();
	if (resume) {
		if (now >= oskDeadline) {
			oskHide();
			return;
		}
	} else {
		oskVisibleSince = now;
		oskDeadline = now + OSK_PEEK_MS;
	}
	oskState = 'visible';
	oskScheduleHide();
	if (!oskTickTimer) oskTickTimer = setInterval(updateOskState, 250);
	renderOsk();
	updateOskState();
}

function oskExtend() {
	oskDeadline = Math.min(oskDeadline + OSK_EXTEND_MS, oskVisibleSince + OSK_MAX_VISIBLE_MS);
	oskScheduleHide();
}

function oskPeek() {
	if (ui.osk.hidden) return;
	if (oskState === 'hidden') {
		oskState = 'revealing';
		updateOskState();
		oskRevealTimer = setTimeout(function () { oskReveal(false); }, OSK_REVEAL_DELAY_MS);
	} else if (oskState === 'visible') {
		// A peek while the keys are up is a click like any other, so it
		// reshuffles rather than silently extending the window: a screen
		// capture taken during the previous window must not still match
		// the layout now on screen.
		oskBurn();
	}
}

// A press that began while labels were (or might still have been) on screen.
function oskBurn() {
	oskLayout = shuffleInPlace(OSK_CHARS.slice());
	if (oskState === 'visible') {
		oskExtend();
		oskState = 'revealing';
		clearTimeout(oskRevealTimer);
		oskRevealTimer = setTimeout(function () { oskReveal(true); }, OSK_REVEAL_DELAY_MS);
	}
	renderOsk();
	updateOskState();
}

// --- open / close ---

function openOsk() {
	ui.osk.hidden = false;
	ui['toggle-osk'].setAttribute('aria-expanded', 'true');
	ui['toggle-osk'].classList.add('on');
	if (!keyboardMode) enterKeyboardMode();
	oskStopTimers();
	oskPress = null;
	// Reshuffle only when there is no password in progress. If the
	// user closes the OSK mid-entry and reopens it, the layout they
	// were working from (and any coordinates they wrote down) stays
	// valid for the rest of the session.
	if (!secret) oskLayout = shuffleInPlace(OSK_CHARS.slice());
	oskState = 'hidden';
	oskHiddenAt = -Infinity;
	renderOsk();
	updateOskState();
	oskPeek();
}

function closeOsk() {
	oskStopTimers();
	oskPress = null;
	oskState = 'hidden';
	updateOskState();
	ui.osk.hidden = true;
	ui['toggle-osk'].setAttribute('aria-expanded', 'false');
	ui['toggle-osk'].classList.remove('on');
	// A partly-typed password keeps its layout (and keyboard mode) so
	// that reopening resumes where the user left off. Only a fresh
	// session releases the layout and exits keyboard mode.
	if (!secret) {
		oskLayout = [];
		leaveKeyboardMode();
	}
}

ui['toggle-osk'].addEventListener('click', function () {
	if (ui.osk.hidden) openOsk();
	else closeOsk();
});

ui['osk-peek'].addEventListener('click', oskPeek);

ui['osk-back'].addEventListener('click', function () {
	setSecret(Array.from(secret).slice(0, -1).join(''));
});

ui['osk-clear'].addEventListener('click', function () {
	setSecret('');
});

// --- presses on the canvas ---

ui['osk-canvas'].addEventListener('pointerdown', function (e) {
	if (oskPress) return;
	if (e.pointerType === 'mouse' && e.button !== 0) return;
	let kind;
	if (oskState === 'visible' || Date.now() - oskHiddenAt < OSK_SETTLE_MS) kind = 'burn';
	else if (oskState === 'revealing') kind = 'ignore';
	else kind = 'type';
	oskPress = { pointerId: e.pointerId, index: oskCell(e), kind: kind };
	try {
		ui['osk-canvas'].setPointerCapture(e.pointerId);
	} catch (err) {
		// synthetic or already-released pointer: nothing to capture
	}
});

function finishOskPress(e, cancelled) {
	const press = oskPress;
	if (!press || press.pointerId !== e.pointerId) return;
	oskPress = null;
	if (press.index < 0) return;
	if (press.kind === 'burn') {
		oskBurn();
	} else if (press.kind === 'type' && !cancelled && oskCell(e) === press.index) {
		setSecret(secret + oskLayout[press.index]);
	}
}

ui['osk-canvas'].addEventListener('pointerup', function (e) { finishOskPress(e, false); });
ui['osk-canvas'].addEventListener('pointercancel', function (e) { finishOskPress(e, true); });

// Any input event while the layout is visible invalidates it: a screenshot
// triggered by that event must not be pairable with the layout the user
// was looking at. Capture phase, so nothing downstream can suppress it.
// This closes the peek-while-visible shortcut (a tap on the peek button,
// which used to extend the window silently) and covers tap-to-wake on
// mobile, backspace, clear, and any other button on the page.
document.addEventListener('pointerdown', function () {
	if (!ui.osk.hidden && oskState === 'visible') oskBurn();
}, true);

// Matching guard for physical key presses. Modifier-only keys, Tab,
// arrows and function keys are not input events for this purpose; a
// printable character, Enter or Backspace is.
document.addEventListener('keydown', function (e) {
	if (ui.osk.hidden || oskState !== 'visible') return;
	if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace') oskBurn();
}, true);

// Leaving the tab hides the keys at once.
document.addEventListener('visibilitychange', function () {
	if (document.visibilityState === 'hidden' && !ui.osk.hidden && oskState !== 'hidden') oskHide();
});

window.addEventListener('resize', function () {
	if (!ui.osk.hidden) renderOsk();
});

// --- local copy reminder ---
//
// Private browsing is deliberately not detected: the tricks are a moving
// target that browsers keep closing, and a false "you are private" would hide
// a reminder that is still needed.  file: is reliable.
ui['local-hint'].hidden = location.protocol === 'file:';

// --- session hygiene ----------------------------------------------------
//
// Forget the master password (and any finished result) after a period of
// inactivity, and shortly after the tab has been hidden.  This limits what
// a walk-away or a shared screen can expose; it is not a defence against
// malware on the device.  Set a value to 0 to disable that rule.

const IDLE_MS = 5 * 60 * 1000;
const HIDDEN_MS = 60 * 1000;
let idleTimer = null;
let hiddenTimer = null;

function wipeSecrets(reason) {
	if (busy) {
		// Let a running derivation finish, then look again.
		setTimeout(function () { wipeSecrets(reason); }, 5000);
		return;
	}
	if (!getMasterPassword() && pw === null) return;
	if (keyboardMode) {
		setSecret('');
	} else {
		ui.mp.value = '';
		ui.mp.type = 'password';
		ui['toggle-mp'].textContent = 'show';
	}
	clearDone();
	say(reason);
}

function armIdleTimer() {
	clearTimeout(idleTimer);
	if (IDLE_MS > 0) {
		idleTimer = setTimeout(function () {
			wipeSecrets('Master password cleared after ' + Math.round(IDLE_MS / 60000) + ' minutes of inactivity.');
		}, IDLE_MS);
	}
}

['keydown', 'pointerdown', 'input', 'focusin'].forEach(function (type) {
	document.addEventListener(type, armIdleTimer, { passive: true });
});
armIdleTimer();

document.addEventListener('visibilitychange', function () {
	clearTimeout(hiddenTimer);
	if (document.visibilityState === 'hidden' && HIDDEN_MS > 0) {
		hiddenTimer = setTimeout(function () {
			wipeSecrets('Master password cleared because this tab was in the background.');
		}, HIDDEN_MS);
	}
});

// --- import -------------------------------------------------------------

ui.import.addEventListener('click', function () {
	ui['import-file'].click();
});

ui['import-file'].addEventListener('change', async function (e) {
	const file = e.target.files && e.target.files[0];
	e.target.value = '';
	if (!file) return;

	let stored;
	try {
		const text = (await file.text()).replace(/^\uFEFF/, '');
		stored = JSON.parse(text);
	} catch (err) {
		say('Could not read the backup file: ' + (err && err.message), true);
		return;
	}

	if (
		!stored ||
		typeof stored !== 'object' ||
		(typeof stored._enc_ !== 'string' &&
			(typeof stored._hosts_ !== 'object' ||
				stored._hosts_ === null))
	) {
		say('This is not a valid rpass backup file.', true);
		return;
	}

	if (typeof stored._enc_ === 'string' && !getMasterPassword()) {
		say('This backup is encrypted. Enter your master password above, then click Import backup again.', true);
		ui.mp.focus();
		return;
	}

	ui.import.disabled = true;
	say('Decrypting backup\u2026');
	let payload;
	try {
		payload = await RpassVault.load(stored, getMasterPassword());
	} catch (err) {
		if (err && err.message === 'wrong-password') {
			say('Wrong master password for this backup.', true);
			ui.mp.focus();
			ui.mp.select();
		} else {
			say('Could not read the backup: ' + (err && err.message ? err.message : err), true);
			console.error(err);
		}
		return;
	} finally {
		ui.import.disabled = false;
	}

	importedStored = stored;
	importedVault = payload;
	populateDatalists(payload);
	say('Backup imported. Service and username suggestions are now available in their fields.');

	// A version mismatch is a persistent condition of this page's
	// state, not a transient status line, so it lives in its own
	// element and stays visible until a new import replaces it.
	const versionWarning = RpassVault.checkVersion(stored);
	if (versionWarning) {
		ui['import-notice'].textContent = '\u26a0 ' + versionWarning;
		ui['import-notice'].hidden = false;
	} else {
		ui['import-notice'].hidden = true;
		ui['import-notice'].textContent = '';
	}

	updateMigrationBadge();
});

function populateDatalists(vault) {
	const servicesList = document.getElementById('services-list');
	const usersList = document.getElementById('users-list');
	servicesList.innerHTML = '';
	usersList.innerHTML = '';

	const services = Object.keys(vault.services || {}).sort();
	for (const s of services) {
		const opt = document.createElement('option');
		opt.value = s;
		servicesList.appendChild(opt);
	}

	const users = new Set();
	for (const s of services) {
		const record = vault.services[s] || {};
		for (const u of Object.keys(record)) users.add(u);
	}
	for (const u of Array.from(users).sort()) {
		const opt = document.createElement('option');
		opt.value = u;
		usersList.appendChild(opt);
	}
}

// Apply the algorithm the backup recorded for this (service, user)
// pair. A wrong algorithm silently produces a different (wrong)
// password, so when the backup has nothing to say about the pair,
// leave the toggle alone and say so.
function applyImportedAlgorithm(service, user) {
	if (!importedVault) return;
	const svc = RpassDerive.normalizeIdentifier(service);
	const usr = RpassDerive.normalizeIdentifier(user);
	const resolved = RpassVault.effectiveAlgorithmFor(
		importedStored, importedVault, svc, usr
	);
	if (resolved === 'v1' || resolved === 'v2') {
		setAlgorithm(resolved);
		return;
	}
	const where = usr ? '"' + svc + '/' + usr + '"' : '"' + svc + '"';
	say(
		'This backup has no v1/v2 record for ' + where +
			'. Check the v1/v2 toggle (currently ' + algorithm + ').',
		false,
		true
	);
}

function maybeAutofillFromImport() {
	if (!importedVault) return;
	const svc = RpassDerive.normalizeIdentifier(ui.service.value);
	const record = importedVault.services[svc];
	if (!record) return;
	const users = Object.keys(record);
	if (users.length === 0) return;
	if (!ui.user.value) ui.user.value = users[0];
	const usr = RpassDerive.normalizeIdentifier(ui.user.value);
	applyImportedAlgorithm(svc, usr);
	const iter = record[usr];
	if (iter !== undefined) ui.iter.value = String(iter);
	// `ui.user.value` was set programmatically, which does not fire
	// a `change` event; refresh the badge here so it reflects the
	// newly-selected user.
	updateMigrationBadge();
}

function maybeAutofillIter() {
	if (!importedVault) return;
	const svc = RpassDerive.normalizeIdentifier(ui.service.value);
	const usr = RpassDerive.normalizeIdentifier(ui.user.value);
	const record = importedVault.services[svc];
	if (!record) return;
	applyImportedAlgorithm(svc, usr);
	const iter = record[usr];
	if (iter !== undefined) ui.iter.value = String(iter);
	updateMigrationBadge();
}

// Per-pair migration state of the currently-selected account, taken
// from the imported backup. Shown only while a backup carrying a
// non-empty `migration` map is loaded and both fields are filled.
// Outside of that window the badge is hidden, matching the web
// app's stateless-and-boring default.
function updateMigrationBadge() {
	const badge = ui['migration-badge'];
	if (!badge) return;
	// Hide when there is no migration map, or when it is present
	// but empty: an empty map means "no migration is or was in
	// progress", so every pair would otherwise read as pending.
	// A populated map — left behind by a browser restart that
	// cleared storage.session, for example — is worth showing.
	if (
		!importedVault ||
		!importedVault.migration ||
		Object.keys(importedVault.migration).length === 0
	) {
		badge.hidden = true;
		return;
	}
	const svc = RpassDerive.normalizeIdentifier(ui.service.value);
	const usr = RpassDerive.normalizeIdentifier(ui.user.value);
	if (!svc || !usr) {
		badge.hidden = true;
		return;
	}
	const entry = importedVault.migration[svc];
	const status = (entry && entry[usr]) || 'pending';
	badge.hidden = false;
	badge.textContent = status;
	badge.classList.toggle('migrated', status === 'migrated');
	badge.classList.toggle('pending', status === 'pending');
	badge.title =
		status === 'migrated'
			? 'Backup recorded this account as migrated to the new master password'
			: 'Backup recorded this account as still on the previous master password';
}

// --- clipboard ----------------------------------------------------------
//
// navigator.clipboard.writeText needs a secure context and (in some
// browsers) transient user activation; fall back to execCommand('copy').
// Both paths return a promise that reflects whether the copy worked.

function copyText(str) {
	if (navigator.clipboard && navigator.clipboard.writeText) {
		return navigator.clipboard.writeText(str).catch(function () {
			return legacyCopy(str);
		});
	}
	return legacyCopy(str);
}

function legacyCopy(str) {
	/* https://github.com/30-seconds/30-seconds-of-code */
	return new Promise(function (resolve, reject) {
		const el = document.createElement('textarea');
		el.value = str;
		el.setAttribute('readonly', '');
		el.style.position = 'absolute';
		el.style.left = '-9999px';
		document.body.appendChild(el);
		const selected =
			document.getSelection().rangeCount > 0
				? document.getSelection().getRangeAt(0)
				: false;
		el.select();
		let ok = false;
		try {
			ok = document.execCommand('copy');
		} catch (err) {
			ok = false;
		}
		el.value = '';
		document.body.removeChild(el);
		if (selected) {
			document.getSelection().removeAllRanges();
			document.getSelection().addRange(selected);
		}
		if (ok) resolve();
		else reject(new Error('copy command failed'));
	});
}
