#!/usr/bin/env python3
"""
Fix algorithm resolution in the web app for v5+ and pre-v4 backups.

- src/assets/js/vault.js gains expandFlatAlgorithms, resolveAlgorithms
  and effectiveAlgorithmFor, mirroring the extension's version-aware
  algorithm resolution (see src/lib/storage/vault.ts and the "Storage
  schema" section of that repo's docs/algorithms.md).
- src/assets/js/main.js tracks the outer StoredVault alongside the
  decrypted payload so the vault version and migration map are
  available to the resolver; applyImportedAlgorithm now reads the
  nested v5+ shape and consults the migration map, so a v6 backup no
  longer produces "no v1/v2 record" for every pair. The migration
  badge is hidden when the imported map is present but empty, which
  is what a v6 backup written outside an active migration carries.
- The stale update.py patch script from an earlier session is deleted.

Run from the repository root: python fix-algorithm-resolution.py

Every edit asserts its anchor was found the expected number of times.
If any edit misses, the script exits non-zero and writes nothing — a
failed run leaves the working tree untouched.
"""
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Callable, Union

ROOT = Path(__file__).resolve().parent


class Patch:
    def __init__(self) -> None:
        self.files: dict[str, str] = {}
        self.newlines: dict[str, str] = {}
        self.deletions: set[str] = set()
        self.errors: list[str] = []
        self.post_steps: list[list[str]] = []

    @staticmethod
    def _ending(raw: str) -> str:
        crlf = raw.count('\r\n')
        lf = raw.count('\n') - crlf
        return '\r\n' if crlf > lf else '\n'

    def post(self, argv: list[str]) -> None:
        self.post_steps.append(argv)

    def _get(self, rel: str) -> str:
        if rel not in self.files:
            raw = (ROOT / rel).read_bytes().decode('utf-8')
            self.newlines[rel] = self._ending(raw)
            self.files[rel] = raw.replace('\r\n', '\n')
        return self.files[rel]

    def replace(self, rel: str, old: str, new: str, count: int = 1) -> None:
        text = self._get(rel)
        n = text.count(old)
        if n != count:
            def norm(s: str) -> str:
                return '\n'.join(l.lstrip() for l in s.split('\n'))
            if count == 1 and norm(old) in norm(text):
                self.errors.append(
                    f'{rel}: anchor found with different leading whitespace'
                )
            else:
                self.errors.append(
                    f'{rel}: expected {count}× {old[:80]!r}, found {n}'
                )
            return
        self.files[rel] = text.replace(old, new)

    def delete(self, rel: str, missing_ok: bool = False) -> None:
        exists = (ROOT / rel).exists() or rel in self.files
        if not exists and not missing_ok:
            self.errors.append(f'{rel}: delete requested but file does not exist')
            return
        self.deletions.add(rel)
        self.files.pop(rel, None)

    def commit(self) -> None:
        if self.errors:
            for e in self.errors:
                print(f'MISS: {e}', file=sys.stderr)
            sys.exit(1)
        for rel, text in self.files.items():
            path = ROOT / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            ending = self.newlines.get(rel, '\n')
            path.write_bytes(text.replace('\n', ending).encode('utf-8'))
            print(f'wrote {rel}')
        for rel in self.deletions:
            path = ROOT / rel
            if path.exists():
                path.unlink()
                print(f'deleted {rel}')
        for argv in self.post_steps:
            print(f'\n$ {" ".join(argv)}')
            result = subprocess.run(argv, cwd=ROOT)
            if result.returncode != 0:
                print(
                    f'\npost-commit step failed: {" ".join(argv)}\n'
                    'Source files were written; only this follow-up is incomplete.',
                    file=sys.stderr,
                )
                sys.exit(1)


p = Patch()

# =====================================================================
# src/assets/js/vault.js — version-aware algorithm resolution
# =====================================================================

p.replace(
    'src/assets/js/vault.js',
    "\tfunction load(stored, mp) {\n"
    "\t\tif (!stored || typeof stored !== 'object') {\n"
    "\t\t\tthrow new Error('not a vault object');\n"
    "\t\t}",
    "\t/**\n"
    "\t * Expand a pre-v5 flat algorithm map (service -> algorithm) into\n"
    "\t * the current nested shape (service -> user -> algorithm).\n"
    "\t *\n"
    "\t * v4-and-earlier vaults stored the algorithm at service level.\n"
    "\t * Only 'v2' was ever written, because v1 is the default for\n"
    "\t * existing pairs; a service marked v2 in the flat map becomes\n"
    "\t * per-user v2 for every existing user of that service. Services\n"
    "\t * without an entry are left alone — their pairs resolve to v1\n"
    "\t * through `effectiveAlgorithmFor`.\n"
    "\t *\n"
    "\t * Lossless: no pair's effective algorithm changes. Mirrors the\n"
    "\t * `expandFlatAlgorithms` helper in the extension's\n"
    "\t * `src/lib/storage/vault.ts`.\n"
    "\t */\n"
    "\tfunction expandFlatAlgorithms(services, flat) {\n"
    "\t\tconst out = {};\n"
    "\t\tif (!flat || typeof flat !== 'object') return out;\n"
    "\t\tfor (const svc of Object.keys(flat)) {\n"
    "\t\t\tconst alg = flat[svc];\n"
    "\t\t\t// Only 'v2' is meaningful; v1 is the implicit default for\n"
    "\t\t\t// existing pairs. Pre-v5 vaults never wrote v1 here.\n"
    "\t\t\tif (alg !== 'v2') continue;\n"
    "\t\t\tconst users = services[svc];\n"
    "\t\t\tif (!users) continue;\n"
    "\t\t\tconst userMap = {};\n"
    "\t\t\tfor (const usr of Object.keys(users)) userMap[usr] = 'v2';\n"
    "\t\t\tif (Object.keys(userMap).length > 0) out[svc] = userMap;\n"
    "\t\t}\n"
    "\t\treturn out;\n"
    "\t}\n"
    "\n"
    "\t/**\n"
    "\t * Version-aware normalisation of the algorithms field inside a\n"
    "\t * decrypted payload.\n"
    "\t *\n"
    "\t * The vault format version lives on the outer StoredVault\n"
    "\t * (`_v_`), not inside the decrypted payload, because the\n"
    "\t * payload is opaque to whoever reads it — its shape is known\n"
    "\t * only from the version that wrote it. A v4 backup's\n"
    "\t * `algorithms` is a flat map; a v5+ backup's is nested. This\n"
    "\t * returns the nested shape either way, so callers can treat\n"
    "\t * the payload uniformly.\n"
    "\t */\n"
    "\tfunction resolveAlgorithms(stored, payload) {\n"
    "\t\tconst v = stored && typeof stored._v_ === 'number' ? stored._v_ : 1;\n"
    "\t\tconst raw = payload.algorithms;\n"
    "\t\tif (!raw || typeof raw !== 'object') return {};\n"
    "\t\tif (v >= 5) return raw;\n"
    "\t\treturn expandFlatAlgorithms(payload.services || {}, raw);\n"
    "\t}\n"
    "\n"
    "\t/**\n"
    "\t * The algorithm a `(service, user)` pair should be derived with,\n"
    "\t * given an imported backup, or `null` if there is no information\n"
    "\t * for that pair.\n"
    "\t *\n"
    "\t * Mirrors the extension's `effectiveAlgorithmFor` plus\n"
    "\t * `algorithmFor` (see the \"Storage schema\" section of that\n"
    "\t * repo's docs/algorithms.md). Resolution order:\n"
    "\t *\n"
    "\t *   1. The migration map (v6+ only) — a pair marked 'migrated'\n"
    "\t *      is on the new master password and therefore always v2.\n"
    "\t *   2. An explicit entry in `algorithms[service][user]` after\n"
    "\t *      version-aware normalisation.\n"
    "\t *   3. No entry, the pair exists in `services` -> v1 (legacy\n"
    "\t *      default).\n"
    "\t *   4. No entry, the pair does not exist -> `null`. The\n"
    "\t *      extension defaults a fresh pair to v2, but this page has\n"
    "\t *      a manual toggle and no way to distinguish \"a fresh\n"
    "\t *      account the user is about to create\" from \"a typo\";\n"
    "\t *      deferring to the toggle is the honest choice.\n"
    "\t */\n"
    "\tfunction effectiveAlgorithmFor(stored, payload, service, user) {\n"
    "\t\tif (!service) return null;\n"
    "\t\tconst v = stored && typeof stored._v_ === 'number' ? stored._v_ : 1;\n"
    "\t\tconst algorithms = resolveAlgorithms(stored, payload);\n"
    "\n"
    "\t\tif (v >= 6 && payload.migration) {\n"
    "\t\t\tconst entry = payload.migration[service];\n"
    "\t\t\tconst status = (entry && entry[user]) || 'pending';\n"
    "\t\t\tif (status === 'migrated') return 'v2';\n"
    "\t\t}\n"
    "\n"
    "\t\tconst explicit = algorithms[service] && algorithms[service][user];\n"
    "\t\tif (explicit === 'v1' || explicit === 'v2') return explicit;\n"
    "\n"
    "\t\tconst pairExists =\n"
    "\t\t\tpayload.services &&\n"
    "\t\t\tpayload.services[service] &&\n"
    "\t\t\tpayload.services[service][user] !== undefined;\n"
    "\t\tif (pairExists) return 'v1';\n"
    "\n"
    "\t\treturn null;\n"
    "\t}\n"
    "\n"
    "\tfunction load(stored, mp) {\n"
    "\t\tif (!stored || typeof stored !== 'object') {\n"
    "\t\t\tthrow new Error('not a vault object');\n"
    "\t\t}"
)

p.replace(
    'src/assets/js/vault.js',
    "\treturn { load: load, checkVersion: checkVersion };\n"
    "})();",
    "\treturn {\n"
    "\t\tload: load,\n"
    "\t\tcheckVersion: checkVersion,\n"
    "\t\tresolveAlgorithms: resolveAlgorithms,\n"
    "\t\teffectiveAlgorithmFor: effectiveAlgorithmFor\n"
    "\t};\n"
    "})();"
)

# =====================================================================
# src/assets/js/main.js — track importedStored, rewrite resolvers
# =====================================================================

p.replace(
    'src/assets/js/main.js',
    "let pw = null;\n"
    "let algorithm = 'v1';\n"
    "let importedVault = null;",
    "let pw = null;\n"
    "let algorithm = 'v1';\n"
    "let importedStored = null;   // outer StoredVault (has _v_)\n"
    "let importedVault = null;    // decrypted payload"
)

p.replace(
    'src/assets/js/main.js',
    "\timportedVault = payload;\n"
    "\tpopulateDatalists(payload);",
    "\timportedStored = stored;\n"
    "\timportedVault = payload;\n"
    "\tpopulateDatalists(payload);"
)

p.replace(
    'src/assets/js/main.js',
    "// Apply the algorithm the backup recorded for this service.  A wrong\n"
    "// algorithm silently produces a different (wrong) password, so when the\n"
    "// backup has no v1/v2 entry for the service, leave the toggle alone and say so.\n"
    "function applyImportedAlgorithm(service) {\n"
    "\tconst recorded = importedVault.algorithms && importedVault.algorithms[service];\n"
    "\tif (recorded === 'v1' || recorded === 'v2') {\n"
    "\t\tsetAlgorithm(recorded);\n"
    "\t\treturn;\n"
    "\t}\n"
    "\tsay(\n"
    "\t\t'This backup records no v1/v2 algorithm for \"' + service +\n"
    "\t\t\t'\". Check the v1/v2 toggle (currently ' + algorithm + ').',\n"
    "\t\tfalse,\n"
    "\t\ttrue\n"
    "\t);\n"
    "}",
    "// Apply the algorithm the backup recorded for this (service, user)\n"
    "// pair. A wrong algorithm silently produces a different (wrong)\n"
    "// password, so when the backup has nothing to say about the pair,\n"
    "// leave the toggle alone and say so.\n"
    "function applyImportedAlgorithm(service, user) {\n"
    "\tif (!importedVault) return;\n"
    "\tconst svc = RpassDerive.normalizeIdentifier(service);\n"
    "\tconst usr = RpassDerive.normalizeIdentifier(user);\n"
    "\tconst resolved = RpassVault.effectiveAlgorithmFor(\n"
    "\t\timportedStored, importedVault, svc, usr\n"
    "\t);\n"
    "\tif (resolved === 'v1' || resolved === 'v2') {\n"
    "\t\tsetAlgorithm(resolved);\n"
    "\t\treturn;\n"
    "\t}\n"
    "\tconst where = usr ? '\"' + svc + '/' + usr + '\"' : '\"' + svc + '\"';\n"
    "\tsay(\n"
    "\t\t'This backup has no v1/v2 record for ' + where +\n"
    "\t\t\t'. Check the v1/v2 toggle (currently ' + algorithm + ').',\n"
    "\t\tfalse,\n"
    "\t\ttrue\n"
    "\t);\n"
    "}"
)

p.replace(
    'src/assets/js/main.js',
    "function maybeAutofillFromImport() {\n"
    "\tif (!importedVault) return;\n"
    "\tconst service = ui.service.value;\n"
    "\tconst record = importedVault.services[service];\n"
    "\tif (!record) return;\n"
    "\tapplyImportedAlgorithm(service);\n"
    "\tconst users = Object.keys(record);\n"
    "\tif (users.length === 0) return;\n"
    "\tif (!ui.user.value) ui.user.value = users[0];\n"
    "\tconst iter = record[ui.user.value];\n"
    "\tif (iter !== undefined) ui.iter.value = String(iter);\n"
    "\t// `ui.user.value` was set programmatically, which does not fire\n"
    "\t// a `change` event; refresh the badge here so it reflects the\n"
    "\t// newly-selected user.\n"
    "\tupdateMigrationBadge();\n"
    "}",
    "function maybeAutofillFromImport() {\n"
    "\tif (!importedVault) return;\n"
    "\tconst svc = RpassDerive.normalizeIdentifier(ui.service.value);\n"
    "\tconst record = importedVault.services[svc];\n"
    "\tif (!record) return;\n"
    "\tconst users = Object.keys(record);\n"
    "\tif (users.length === 0) return;\n"
    "\tif (!ui.user.value) ui.user.value = users[0];\n"
    "\tconst usr = RpassDerive.normalizeIdentifier(ui.user.value);\n"
    "\tapplyImportedAlgorithm(svc, usr);\n"
    "\tconst iter = record[usr];\n"
    "\tif (iter !== undefined) ui.iter.value = String(iter);\n"
    "\t// `ui.user.value` was set programmatically, which does not fire\n"
    "\t// a `change` event; refresh the badge here so it reflects the\n"
    "\t// newly-selected user.\n"
    "\tupdateMigrationBadge();\n"
    "}"
)

p.replace(
    'src/assets/js/main.js',
    "function maybeAutofillIter() {\n"
    "\tif (!importedVault) return;\n"
    "\tconst record = importedVault.services[ui.service.value];\n"
    "\tif (!record) return;\n"
    "\tapplyImportedAlgorithm(ui.service.value);\n"
    "\tconst iter = record[ui.user.value];\n"
    "\tif (iter !== undefined) ui.iter.value = String(iter);\n"
    "\tupdateMigrationBadge();\n"
    "}",
    "function maybeAutofillIter() {\n"
    "\tif (!importedVault) return;\n"
    "\tconst svc = RpassDerive.normalizeIdentifier(ui.service.value);\n"
    "\tconst usr = RpassDerive.normalizeIdentifier(ui.user.value);\n"
    "\tconst record = importedVault.services[svc];\n"
    "\tif (!record) return;\n"
    "\tapplyImportedAlgorithm(svc, usr);\n"
    "\tconst iter = record[usr];\n"
    "\tif (iter !== undefined) ui.iter.value = String(iter);\n"
    "\tupdateMigrationBadge();\n"
    "}"
)

p.replace(
    'src/assets/js/main.js',
    "\tif (!importedVault || !importedVault.migration) {\n"
    "\t\tbadge.hidden = true;\n"
    "\t\treturn;\n"
    "\t}",
    "\t// Hide when there is no migration map, or when it is present\n"
    "\t// but empty: an empty map means \"no migration is or was in\n"
    "\t// progress\", so every pair would otherwise read as pending.\n"
    "\t// A populated map — left behind by a browser restart that\n"
    "\t// cleared storage.session, for example — is worth showing.\n"
    "\tif (\n"
    "\t\t!importedVault ||\n"
    "\t\t!importedVault.migration ||\n"
    "\t\tObject.keys(importedVault.migration).length === 0\n"
    "\t) {\n"
    "\t\tbadge.hidden = true;\n"
    "\t\treturn;\n"
    "\t}"
)

p.delete('update.py', missing_ok=True)

p.post([sys.executable, 'scripts/build-single-file.py'])

p.commit()