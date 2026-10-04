'use strict';

/*
 * rpass backup reading.
 *
 * v4 backups are AES-256-GCM ciphertext keyed by a scrypt-derived
 * master key. The key schedule, salt format, HKDF labels and cipher
 * are identical to the Firefox extension's src/lib/crypto/vault-key.ts
 * and are documented in its docs/algorithms.md. This file produces the
 * same plaintext for the same blob and master password.
 *
 * Pre-v4 backups are plaintext JSON; this file just reshapes them.
 *
 * Two shapes are accepted by `load`:
 *   - stored-vault v4:  { _encSalt_, _encIv_, _enc_, _check_ }
 *   - raw EncryptedBlob: { salt, iv, ciphertext, check }
 * The second matches the extension's vault-key.ts test vector; the
 * first is what actually lives on disk in a v4 vault.
 *
 * Requires `scrypt` (from scrypt-async.min.js) to be loaded first.
 * No DOM access, no side effects on load.
 */

const RpassVault = (function () {
	const VAULT_KEY_PREFIX = 'rpass-vault-key';
	const INFO_ENC = 'rpass-vault-enc';
	const INFO_CHECK = 'rpass-vault-check';

	const VAULT_KEY_PARAMS = {
		N: 1 << 17,
		r: 8,
		p: 1,
		dkLen: 32,
		interruptStep: 1000,
		encoding: undefined
	};

	/*
	 * Highest vault format version this page knows how to interpret.
	 * Bump in lockstep with the extension when a new format version
	 * lands. A backup whose `_v_` exceeds this may carry fields this
	 * page would silently misread (or miss entirely), so the importer
	 * warns — it does not refuse. Silent wrong passwords are the
	 * failure mode being guarded against.
	 */
	const KNOWN_VAULT_VERSION = 6;

	function base64ToBytes(b64) {
		const binary = atob(b64);
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	}

	function bytesToBase64(bytes) {
		let binary = '';
		for (let i = 0; i < bytes.length; i++) {
			binary += String.fromCharCode(bytes[i]);
		}
		return btoa(binary);
	}

	function deriveMasterKey(mp, salt) {
		const saltInput = VAULT_KEY_PREFIX + '|' + bytesToBase64(salt);
		return new Promise(function (resolve) {
			scrypt(mp, saltInput, VAULT_KEY_PARAMS, function (derived) {
				resolve(new Uint8Array(derived));
			});
		});
	}

	async function hkdf(ikm, info) {
		const imported = await crypto.subtle.importKey(
			'raw',
			ikm,
			'HKDF',
			false,
			['deriveBits']
		);
		return crypto.subtle.deriveBits(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: new Uint8Array(0),
				info: new TextEncoder().encode(info)
			},
			imported,
			256
		);
	}

	function equalBytes(a, b) {
		if (a.length !== b.length) return false;
		let diff = 0;
		for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
		return diff === 0;
	}

	/**
	 * Decrypt a raw EncryptedBlob ({ salt, iv, ciphertext, check }).
	 */
	async function decryptBlob(blob, mp) {
		if (!mp) throw new Error('wrong-password');

		const salt = base64ToBytes(blob.salt);
		const iv = base64ToBytes(blob.iv);
		const ciphertext = base64ToBytes(blob.ciphertext);
		const expectedCheck = base64ToBytes(blob.check);

		const master = await deriveMasterKey(mp, salt);
		const encKeyBits = await hkdf(master, INFO_ENC);
		const checkBits = await hkdf(master, INFO_CHECK);

		if (!equalBytes(new Uint8Array(checkBits), expectedCheck)) {
			throw new Error('wrong-password');
		}

		const encKey = await crypto.subtle.importKey(
			'raw',
			encKeyBits,
			'AES-GCM',
			false,
			['decrypt']
		);
		const plaintext = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: iv },
			encKey,
			ciphertext
		);
		return JSON.parse(new TextDecoder().decode(plaintext));
	}

	function readPlaintext(stored) {
		const services = {};
		for (const key of Object.keys(stored)) {
			if (key.startsWith('_')) continue;
			services[key] = stored[key];
		}
		return {
			hosts: stored._hosts_ || {},
			algorithms: stored._alg_ || {},
			created: stored._created_ || {},
			lastExport: stored._lastExport_ || null,
			services: services
		};
	}

	/**
	 * Return a human-readable warning if the stored vault declares a
	 * format version higher than this page understands, or `null` if
	 * it looks fine. A missing `_v_` is version 1 and never warns.
	 */
	function checkVersion(stored) {
		if (!stored || typeof stored !== 'object') return null;
		const v = stored._v_;
		if (typeof v !== 'number') return null;
		if (v > KNOWN_VAULT_VERSION) {
			return (
				'This backup was written by a newer version of rpass (v' +
				v +
				'); this page understands up to v' +
				KNOWN_VAULT_VERSION +
				'. Some fields may be missing or interpreted ' +
				'incorrectly.'
			);
		}
		return null;
	}

	/**
	 * Expand a pre-v5 flat algorithm map (service -> algorithm) into
	 * the current nested shape (service -> user -> algorithm).
	 *
	 * v4-and-earlier vaults stored the algorithm at service level.
	 * Only 'v2' was ever written, because v1 is the default for
	 * existing pairs; a service marked v2 in the flat map becomes
	 * per-user v2 for every existing user of that service. Services
	 * without an entry are left alone — their pairs resolve to v1
	 * through `effectiveAlgorithmFor`.
	 *
	 * Lossless: no pair's effective algorithm changes. Mirrors the
	 * `expandFlatAlgorithms` helper in the extension's
	 * `src/lib/storage/vault.ts`.
	 */
	function expandFlatAlgorithms(services, flat) {
		const out = {};
		if (!flat || typeof flat !== 'object') return out;
		for (const svc of Object.keys(flat)) {
			const alg = flat[svc];
			// Only 'v2' is meaningful; v1 is the implicit default for
			// existing pairs. Pre-v5 vaults never wrote v1 here.
			if (alg !== 'v2') continue;
			const users = services[svc];
			if (!users) continue;
			const userMap = {};
			for (const usr of Object.keys(users)) userMap[usr] = 'v2';
			if (Object.keys(userMap).length > 0) out[svc] = userMap;
		}
		return out;
	}

	/**
	 * Version-aware normalisation of the algorithms field inside a
	 * decrypted payload.
	 *
	 * The vault format version lives on the outer StoredVault
	 * (`_v_`), not inside the decrypted payload, because the
	 * payload is opaque to whoever reads it — its shape is known
	 * only from the version that wrote it. A v4 backup's
	 * `algorithms` is a flat map; a v5+ backup's is nested. This
	 * returns the nested shape either way, so callers can treat
	 * the payload uniformly.
	 */
	function resolveAlgorithms(stored, payload) {
		const v = stored && typeof stored._v_ === 'number' ? stored._v_ : 1;
		const raw = payload.algorithms;
		if (!raw || typeof raw !== 'object') return {};
		if (v >= 5) return raw;
		return expandFlatAlgorithms(payload.services || {}, raw);
	}

	/**
	 * The algorithm a `(service, user)` pair should be derived with,
	 * given an imported backup, or `null` if there is no information
	 * for that pair.
	 *
	 * Mirrors the extension's `effectiveAlgorithmFor` plus
	 * `algorithmFor` (see the "Storage schema" section of that
	 * repo's docs/algorithms.md). Resolution order:
	 *
	 *   1. The migration map (v6+ only) — a pair marked 'migrated'
	 *      is on the new master password and therefore always v2.
	 *   2. An explicit entry in `algorithms[service][user]` after
	 *      version-aware normalisation.
	 *   3. No entry, the pair exists in `services` -> v1 (legacy
	 *      default).
	 *   4. No entry, the pair does not exist -> `null`. The
	 *      extension defaults a fresh pair to v2, but this page has
	 *      a manual toggle and no way to distinguish "a fresh
	 *      account the user is about to create" from "a typo";
	 *      deferring to the toggle is the honest choice.
	 */
	function effectiveAlgorithmFor(stored, payload, service, user) {
		if (!service) return null;
		const v = stored && typeof stored._v_ === 'number' ? stored._v_ : 1;
		const algorithms = resolveAlgorithms(stored, payload);

		if (v >= 6 && payload.migration) {
			const entry = payload.migration[service];
			const status = (entry && entry[user]) || 'pending';
			if (status === 'migrated') return 'v2';
		}

		const explicit = algorithms[service] && algorithms[service][user];
		if (explicit === 'v1' || explicit === 'v2') return explicit;

		const pairExists =
			payload.services &&
			payload.services[service] &&
			payload.services[service][user] !== undefined;
		if (pairExists) return 'v1';

		return null;
	}

	function load(stored, mp) {
		if (!stored || typeof stored !== 'object') {
			throw new Error('not a vault object');
		}

		// Stored-vault v4 shape.
		if (
			typeof stored._enc_ === 'string' &&
			typeof stored._encSalt_ === 'string' &&
			typeof stored._encIv_ === 'string' &&
			typeof stored._check_ === 'string'
		) {
			return decryptBlob(
				{
					salt: stored._encSalt_,
					iv: stored._encIv_,
					ciphertext: stored._enc_,
					check: stored._check_
				},
				mp
			);
		}

		// Raw EncryptedBlob shape (used by the golden-vector test).
		if (
			typeof stored.ciphertext === 'string' &&
			typeof stored.salt === 'string' &&
			typeof stored.iv === 'string' &&
			typeof stored.check === 'string'
		) {
			return decryptBlob(stored, mp);
		}

		// Otherwise: pre-v4 plaintext backup.
		return Promise.resolve(readPlaintext(stored));
	}

	return {
		load: load,
		checkVersion: checkVersion,
		resolveAlgorithms: resolveAlgorithms,
		effectiveAlgorithmFor: effectiveAlgorithmFor
	};
})();
