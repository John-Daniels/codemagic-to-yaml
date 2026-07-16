# codemagic-to-yaml

**Export your Codemagic UI-configured Flutter workflows to `codemagic.yaml`.**
Runs entirely in your browser — nothing is uploaded. No install, no build step.

> Codemagic lets you configure builds in its web UI but has **no “export to YAML”**
> button. The UI is driven by an internal API that returns the full workflow config as
> JSON. This tool converts that JSON into a ready-to-commit `codemagic.yaml`.

---

## How to use

1. **Open the app** — double-click `index.html`, or use the hosted page (GitHub Pages).
2. **Grab the config JSON from Codemagic:**
   - Open your app in the Codemagic web UI.
   - Open your browser **DevTools → Network** tab, then reload the app page.
   - Find the request to `api.codemagic.io/apps/<id>` and copy its **JSON response**
     (right-click → Copy → Copy response).
3. **Paste** it into the left panel (or drop a saved `.json` file) and click **Convert →**.
4. **Resolve the TODOs** printed at the top of the output — secrets can’t be exported
   (see below), so re-add them once in the Codemagic UI.
5. **Download** `codemagic.yaml` and commit it to your repository root.

> Tip: you can paste multiple app responses at once (concatenated objects) — the tool
> emits one workflow block per workflow found.

---

## What converts, and what can’t

Everything **structural** converts cleanly. The only gap is **secrets**, which the
Codemagic API never returns — no tool can recover them:

| Exported ✅ | Not exportable ❌ (re-add in Codemagic UI) |
|---|---|
| name, instance_type, max_build_duration | keystore / key passwords (shown as `********`) |
| environment (flutter/xcode/cocoapods, vars) | uploaded files (`.jks`, service-account `.json`, ASC key) |
| triggering (events, branch_patterns) | secure env var **values** |
| scripts (custom + test runners + build steps) | Shorebird token |
| artifacts | |
| publishing (email, google_play, app_store_connect, firebase, slack) | |
| cache, triggering (branch + tag patterns), app-level env vars | |
| platforms: android, ios, macOS, Windows, web | |

For each secret, the output emits a **named reference** (e.g.
`android_signing: [keystore_reference]`, `$GOOGLE_PLAY_SERVICE_ACCOUNT_CREDENTIALS`) plus a
`TODO` line — exactly how a hand-written `codemagic.yaml` refers to them.

---

## Field mapping

| YAML | Source (API JSON) | Docs |
|---|---|---|
| `max_build_duration` | `maxBuildDuration` ÷ 60 (sec→min) | [getting-started](https://docs.codemagic.io/yaml/yaml-getting-started/) |
| `environment.flutter/xcode/cocoapods` | `buildSettings.*Version` | [getting-started](https://docs.codemagic.io/yaml/yaml-getting-started/#environment) |
| `environment.android_signing` | `codeSigning.android` | [signing-android](https://docs.codemagic.io/yaml-code-signing/signing-android/) |
| `environment.ios_signing` | `codeSigning.ios` | [signing-ios](https://docs.codemagic.io/yaml-code-signing/signing-ios/) |
| `triggering` | `branchPatterns`, `buildSettings.automaticBuilds/…` | [triggering](https://docs.codemagic.io/yaml/yaml-getting-started/#triggering) |
| `scripts` | `customScripts` + `testRunners` + build settings | [scripts](https://docs.codemagic.io/yaml/yaml-getting-started/#scripts) |
| `cache.cache_paths` | `dependencyCache` | [cache](https://docs.codemagic.io/yaml/yaml-getting-started/#cache) |
| `publishing.google_play` | `publishers.googlePlay` | [google-play](https://docs.codemagic.io/yaml-publishing/google-play/) |
| `publishing.app_store_connect` | `publishers.appStoreConnect` | [app-store-connect](https://docs.codemagic.io/yaml-publishing/app-store-connect/) |
| `publishing.firebase` | `publishers.firebase` | [firebase](https://docs.codemagic.io/yaml-publishing/firebase-app-distribution/) |
| `publishing.slack` | `publishers.slack` | [slack](https://docs.codemagic.io/yaml-publishing/slack/) |

---

## Project structure

```
index.html            # UI shell (Tailwind via CDN) — markup + meta tags only
scripts/converter.js  # conversion logic — CodemagicConverter.convert(json) → { yaml, count }
scripts/main.js       # app layer — DOM wiring; calls converter, renders output
icon.svg              # icon / favicon
```

The **logic and the UI are fully separated**: `converter.js` has no DOM code, so it can be
reused, unit-tested, and read on its own. `main.js` never contains conversion logic — it just
calls `CodemagicConverter.convert(text)`.

---

## Contributing

No build step, no dependencies.

- **Fix a mapping / add a field:** edit `scripts/converter.js` only. Add a doc link comment
  for any new Codemagic field you map.
- **Run the built-in self-test:** open `index.html?selftest` and check the console for
  `SELFTEST PASSED ✅`.
- **Run the logic under Node** (same file loads via `globalThis`):

  ```js
  // verify.mjs
  import fs from "fs";
  const js = fs.readFileSync("scripts/converter.js", "utf8");
  (0, eval)(js);
  const { yaml, count } = globalThis.CodemagicConverter.convert(fs.readFileSync("workflow.json", "utf8"));
  console.log(count, "workflows\n", yaml);
  ```

  Then sanity-check that the output is valid YAML (e.g. `ruby -ryaml -e 'YAML.load_file("out.yaml")'`).

Run the test suite with `npm test` (Node's built-in `node:test`, zero dependencies).

PRs welcome — especially non-Flutter project types and additional publishers.

> **Offline note:** the UI styles via the Tailwind Play CDN, so first load needs internet.
> The conversion itself runs offline. To use fully offline, vendor a compiled `tailwind.css`
> and swap the CDN `<script>` for a local `<link>`.

---

## Reporting an issue / a missing mapping

Something converted wrong, or a field you use isn't handled? Open an issue at
`https://github.com/John-Daniels/codemagic-to-yaml/issues` with:

1. **Your workflow JSON** — the `api.codemagic.io/apps/<id>` response — **with secrets redacted.**
   The tool never *outputs* secrets, but the input JSON can still contain non-secure values
   (env vars, emails, repo URLs). Replace anything sensitive with `REDACTED` before pasting.
2. **What's wrong or missing** — which YAML field, what you expected vs. what you got.

Worthwhile cases become a patch plus a test fixture built from your redacted JSON. Rarely-used
publishers (snapcraft, partnerCenter, static pages) aren't mapped yet — flag one via an issue if
you actually need it.

## License

[MIT](LICENSE)
