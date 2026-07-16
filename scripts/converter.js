/**
 * codemagic-to-yaml — conversion logic (pure, no DOM).
 *
 * Codemagic has no "export workflow to YAML" button. But its web UI is driven by
 * an internal API — GET https://api.codemagic.io/apps/<id> — whose JSON response
 * holds the full workflow config. This module turns that JSON into a
 * codemagic.yaml string.
 *
 * Public API:
 *   CodemagicConverter.convert(jsonText) -> { yaml, count }
 *   CodemagicConverter.VERSION
 *
 * The one hard limit: Codemagic never returns secrets (passwords show as
 * "********", uploaded keystores/keys are opaque UUID paths, secure env values
 * are absent). Those can't be exported — we emit named references + TODO notes
 * instead, exactly how a hand-written codemagic.yaml refers to them.
 *
 * Loads in the browser (attaches to window) and in Node (attaches to globalThis),
 * so the same file backs the app and the test harness.
 */
(function (global) {
  "use strict";

  const VERSION = "1.0.0";

  /* =========================================================================
   * 1. Minimal YAML emitter
   * We build the output object graph ourselves, so a tiny emitter is enough —
   * no need to bundle js-yaml.
   * ====================================================================== */

  // Strings matching these must be quoted so YAML doesn't read them as
  // booleans / numbers / null.
  const YAML_RESERVED = /^(true|false|yes|no|on|off|null|~|-?\d+(\.\d+)?)$/i;

  // Marks a value that should render as a multi-line "|" block scalar (scripts).
  function Script(text) {
    this.text = text;
  }

  // Render one scalar. Emit bare only when plainly safe; otherwise JSON.stringify()
  // — a JSON string is always a valid YAML double-quoted scalar, keeping us correct
  // on URLs, "a: b" values, API keys, etc.
  function scalar(v) {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "number") return String(v);
    let s = String(v);
    if (s !== "" && /^[\w.\/@-]+$/.test(s) && !YAML_RESERVED.test(s)) return s;
    return JSON.stringify(s);
  }

  function inlineScalar(v, indent) {
    return v instanceof Script ? blockScalar(v.text, indent) : scalar(v);
  }

  function blockScalar(text, indent) {
    let pad = "  ".repeat(indent + 1);
    let lines = String(text).replace(/\n+$/, "").split("\n");
    return "|\n" + lines.map(function (l) { return pad + l; }).join("\n");
  }

  // Recursively emit an object / array / scalar as YAML.
  function emit(node, indent) {
    let pad = "  ".repeat(indent);
    let out = "";

    if (Array.isArray(node)) {
      if (node.length === 0) return pad + "[]\n";
      node.forEach(function (item) {
        if (item && typeof item === "object" && !(item instanceof Script)) {
          // Object element: render the child, then splice "- " over its indent.
          let block = emit(item, indent + 1);
          out += pad + "- " + block.slice(pad.length + 2);
        } else {
          out += pad + "- " + inlineScalar(item, indent) + "\n";
        }
      });
      return out;
    }

    Object.keys(node).forEach(function (k) {
      let v = node[k];
      if (v === undefined) return;
      if (v && typeof v === "object" && !(v instanceof Script)) {
        let isEmpty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
        if (isEmpty) {
          out += pad + k + ": " + (Array.isArray(v) ? "[]" : "{}") + "\n";
        } else {
          out += pad + k + ":\n" + emit(v, indent + 1);
        }
      } else {
        out += pad + k + ": " + inlineScalar(v, indent) + "\n";
      }
    });
    return out;
  }

  /* =========================================================================
   * 2. Input parsing & helpers
   * ====================================================================== */

  // Input may be one JSON object, or several concatenated objects with //
  // comments between them (as in a hand-saved workflow.json). Scan for balanced
  // top-level {...} blocks and JSON.parse each.
  function parseApps(text) {
    let apps = [];
    let depth = 0, start = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      let c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === "{") { if (depth === 0) start = i; depth++; }
      else if (c === "}") {
        depth--;
        if (depth === 0 && start >= 0) {
          try { apps.push(JSON.parse(text.slice(start, i + 1))); } catch (e) { /* skip non-JSON junk */ }
          start = -1;
        }
      }
    }
    return apps;
  }

  function slug(s) {
    return String(s || "workflow")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "workflow";
  }

  /* =========================================================================
   * 3. Mapping: one Codemagic workflow object -> a YAML-ready object
   * Field reference: https://docs.codemagic.io/yaml/yaml-getting-started/
   * ====================================================================== */

  function convertWorkflow(wf, application, todos) {
    let b = wf.buildSettings || {};
    let platforms = Array.isArray(b.platforms) ? b.platforms : [];
    let y = {};

    y.name = wf.name || "Workflow";
    if (wf.instanceType) y.instance_type = wf.instanceType;
    // JSON stores seconds; YAML wants minutes.
    if (wf.maxBuildDuration) y.max_build_duration = Math.round(wf.maxBuildDuration / 60);

    y.environment = buildEnvironment(wf, b, application, todos);
    let cache = buildCache(wf);
    if (cache) y.cache = cache;
    let trig = buildTriggering(wf, b);
    if (trig) y.triggering = trig;
    y.scripts = buildScripts(wf, b, platforms, todos);
    y.artifacts = buildArtifacts(b, platforms);
    let pub = buildPublishing(wf, todos);
    if (pub) y.publishing = pub;

    return y;
  }

  // The Flutter build mode flag, e.g. "--release". Defaults to release.
  function buildModeFlag(b) {
    let mode = b.flutterMode === "debug" || b.flutterMode === "profile" ? b.flutterMode : "release";
    return "--" + mode + (b.flutterVerbose ? " --verbose" : "");
  }

  // https://docs.codemagic.io/yaml/yaml-getting-started/#environment
  function buildEnvironment(wf, b, application, todos) {
    let env = {};
    if (b.flutterVersion) env.flutter = b.flutterVersion;
    if (b.xcodeVersion) env.xcode = b.xcodeVersion;
    if (b.cocoapodsVersion) env.cocoapods = b.cocoapodsVersion;

    let cs = wf.codeSigning || {};
    if (cs.android && cs.android.enabled) {
      // https://docs.codemagic.io/yaml-code-signing/signing-android/
      env.android_signing = ["keystore_reference"];
      todos.add("Android signing: upload your keystore in Codemagic → Code signing identities, then set the reference name (here: `keystore_reference`).");
    }
    if (cs.ios && cs.ios.enabled) {
      // https://docs.codemagic.io/yaml-code-signing/signing-ios/
      let known = { app_store: 1, ad_hoc: 1, development: 1, enterprise: 1 };
      let ios = {
        distribution_type: known[cs.ios.developerPortalProfileType] ? cs.ios.developerPortalProfileType : "app_store",
      };
      if (cs.ios.developerPortalBundleIdentifier) ios.bundle_identifier = cs.ios.developerPortalBundleIdentifier;
      env.ios_signing = ios;
      todos.add("iOS signing: add your App Store Connect API key & bundle certificates in Codemagic → Code signing identities (matched by bundle_identifier / distribution_type).");
    }
    if (cs.macos && cs.macos.enabled) {
      todos.add("macOS signing was enabled in the UI but has no clean YAML export — set it up manually per https://docs.codemagic.io/yaml-code-signing/signing-macos/");
    }

    let vars = {}, groups = [];
    let addVar = function (ev) {
      if (ev.secure) {
        if (groups.indexOf(ev.name) < 0) groups.push(ev.name);
        todos.add("Secure env var value not exported: `" + ev.name + "`. Re-enter it in Codemagic UI under a variable group and list the group here.");
      } else {
        vars[ev.name] = ev.value;
      }
    };
    // App-level variables apply to every workflow; add them first so a
    // workflow-level variable of the same name wins.
    let appEnv = (application && application.appEnvironmentVariables) || {};
    (appEnv.variables || []).forEach(addVar);
    (appEnv.groups || []).forEach(function (g) { if (groups.indexOf(g) < 0) groups.push(g); });
    (wf.environmentVariables || []).forEach(addVar);
    if (Object.keys(vars).length) env.vars = vars;

    if (wf.publishers && wf.publishers.googlePlay && wf.publishers.googlePlay.enabled && groups.indexOf("google_play") < 0) {
      groups.push("google_play");
    }
    if (groups.length) env.groups = groups;

    return env;
  }

  // https://docs.codemagic.io/yaml/yaml-getting-started/#cache
  function buildCache(wf) {
    let dc = wf.dependencyCache || {};
    if (!dc.enabled || !(dc.cachePaths || []).length) return null;
    return { cache_paths: dc.cachePaths };
  }

  // https://docs.codemagic.io/yaml/yaml-getting-started/#triggering
  function buildTriggering(wf, b) {
    let trig = {};
    let events = [];
    if (b.automaticBuilds) events.push("push");
    if (b.buildOnPrUpdate) events.push("pull_request");
    if (b.tagBuilds) events.push("tag");
    if (events.length) trig.events = events;

    let toPattern = function (t) {
      let pattern = t[0], include = t[1], kind = t[2];
      let p = { pattern: pattern, include: include !== false };
      if (kind === "source") p.source = true;
      else if (kind === "target") p.target = true;
      return p;
    };
    let bps = (wf.branchPatterns || []).map(toPattern);
    if (bps.length) trig.branch_patterns = bps;
    let tps = (wf.tagPatterns || []).map(toPattern);
    if (tps.length) trig.tag_patterns = tps;
    if (b.cancelPreviousBuilds) trig.cancel_previous_builds = true;

    return Object.keys(trig).length ? trig : null;
  }

  // https://docs.codemagic.io/yaml/yaml-getting-started/#scripts
  function buildScripts(wf, b, platforms, todos) {
    let scripts = [];
    let custom = wf.customScripts || {};
    let add = function (name, text) {
      if (text && String(text).trim()) scripts.push({ name: name, script: new Script(text) });
    };

    add("Post-clone", custom.postClone);

    // UI test runners become plain flutter commands.
    let tr = wf.testRunners || {};
    if (tr.flutterAnalyze) scripts.push({ name: "Flutter analyze", script: new Script("flutter analyze") });
    if (tr.flutterTest) {
      let step = { name: "Flutter unit tests", script: new Script("flutter test") };
      if (!tr.stopBuildIfTestsFail) step.ignore_failure = true;
      scripts.push(step);
    }
    if (tr.flutterDrive) {
      add("Flutter integration tests", "flutter drive --target=test_driver/app.dart" +
        "\n# adjust --target to your integration test entrypoint");
    }

    add("Pre-build", custom.preBuild);

    let mode = buildModeFlag(b); // e.g. "--release" (+ " --verbose")
    if (platforms.indexOf("android") >= 0) {
      let fmt = b.androidBuildOutputFormat === "apk" ? "apk" : "appbundle";
      let aArgs = (b.androidBuildArguments || "").trim();
      add("Build Android (" + fmt + ")", "flutter build " + fmt + " " + mode + (aArgs ? " " + aArgs : ""));
    }
    if (platforms.indexOf("ios") >= 0) {
      let iArgs = (b.iosBuildArguments || "").trim();
      add("Build iOS", "flutter build ipa " + mode + (iArgs ? " " + iArgs : "") +
        "\n# --export-options-plist may be needed depending on your signing setup");
    }
    if (platforms.indexOf("macos") >= 0) add("Build macOS", "flutter build macos " + mode);
    if (platforms.indexOf("windows") >= 0) add("Build Windows", "flutter build windows " + mode);
    if (platforms.indexOf("web") >= 0) add("Build web", "flutter build web " + mode);
    if (b.shorebird && b.shorebird.enabled) {
      todos.add("Shorebird is enabled: its token isn't exported. Add SHOREBIRD_TOKEN as a secret let and replace the flutter build steps with `shorebird release android/ios` as needed.");
    }

    add("Post-build", custom.postBuild);
    add("Pre-test", custom.preTest);
    add("Post-test", custom.postTest);
    add("Pre-publish", custom.prePublish);
    add("Post-publish", custom.postPublish);

    return scripts;
  }

  // https://docs.codemagic.io/yaml/yaml-getting-started/#artifacts
  function buildArtifacts(b, platforms) {
    let artifacts = [];
    if (platforms.indexOf("android") >= 0) {
      artifacts.push(b.androidBuildOutputFormat === "apk"
        ? "build/**/outputs/**/*.apk"
        : "build/**/outputs/**/*.aab");
      artifacts.push("build/**/outputs/**/mapping.txt");
    }
    if (platforms.indexOf("ios") >= 0) artifacts.push("build/ios/ipa/*.ipa");
    if (platforms.indexOf("macos") >= 0) artifacts.push("build/macos/**/*.app");
    if (platforms.indexOf("windows") >= 0) artifacts.push("build/windows/**/Release/**");
    if (platforms.indexOf("web") >= 0) artifacts.push("build/web/**");
    artifacts.push("flutter_drive.log");
    return artifacts;
  }

  // https://docs.codemagic.io/yaml-publishing/
  function buildPublishing(wf, todos) {
    let pub = wf.publishers || {};
    let out = {};

    if (pub.email && pub.email.enabled && (pub.email.recipients || []).length) {
      out.email = { recipients: pub.email.recipients };
    }
    if (pub.googlePlay && pub.googlePlay.enabled) {
      // https://docs.codemagic.io/yaml-publishing/google-play/
      let gp = pub.googlePlay;
      out.google_play = {
        credentials: "$GOOGLE_PLAY_SERVICE_ACCOUNT_CREDENTIALS",
        track: gp.customTrack || gp.track || "internal",
      };
      if (gp.submitAsDraft) out.google_play.submit_as_draft = true;
      if (gp.rolloutFraction != null) out.google_play.rollout_fraction = gp.rolloutFraction;
      if (gp.inAppUpdatePriority != null) out.google_play.in_app_update_priority = gp.inAppUpdatePriority;
      if (gp.changesNotSentForReview) out.google_play.changes_not_sent_for_review = true;
      todos.add("Google Play: paste your service-account JSON into a secret let`GOOGLE_PLAY_SERVICE_ACCOUNT_CREDENTIALS` (group `google_play`). The uploaded file isn't exported.");
    }
    if (pub.appStoreConnect && pub.appStoreConnect.enabled) {
      // https://docs.codemagic.io/yaml-publishing/app-store-connect/
      let asc = pub.appStoreConnect;
      out.app_store_connect = {
        api_key: "$APP_STORE_CONNECT_PRIVATE_KEY",
        key_id: "$APP_STORE_CONNECT_KEY_IDENTIFIER",
        issuer_id: "$APP_STORE_CONNECT_ISSUER_ID",
      };
      if (asc.submitToTestflight) out.app_store_connect.submit_to_testflight = true;
      if (asc.submitToAppStore) out.app_store_connect.submit_to_app_store = true;
      if (asc.releaseType) out.app_store_connect.release_type = asc.releaseType;
      if (asc.submitToBetaGroups && (asc.betaGroups || []).length) out.app_store_connect.beta_groups = asc.betaGroups;
      todos.add("App Store Connect: add your ASC API key as secret vars (APP_STORE_CONNECT_PRIVATE_KEY / KEY_IDENTIFIER / ISSUER_ID). The key file isn't exported.");
    }
    if (pub.firebase && pub.firebase.enabled) {
      // https://docs.codemagic.io/yaml-publishing/firebase-app-distribution/
      out.firebase = { firebase_service_account: "$FIREBASE_SERVICE_ACCOUNT" };
      let fbPlatform = function (p) {
        if (!p || (!p.appId && !(p.groups || []).length)) return undefined;
        let o = {};
        if (p.appId) o.app_id = p.appId;
        if ((p.groups || []).length) o.groups = p.groups;
        return o;
      };
      let fbAndroid = fbPlatform(pub.firebase.android);
      let fbIos = fbPlatform(pub.firebase.ios);
      if (fbAndroid) out.firebase.android = fbAndroid;
      if (fbIos) out.firebase.ios = fbIos;
      todos.add("Firebase App Distribution: add your service-account JSON as a secret let`FIREBASE_SERVICE_ACCOUNT`. The token/service account isn't exported.");
    }
    if (pub.slack && pub.slack.enabled && pub.slack.channel) {
      // https://docs.codemagic.io/yaml-publishing/slack/
      out.slack = { channel: pub.slack.channel, notify_on_build_start: false };
      todos.add("Slack: connect the Slack integration in Codemagic (Team settings → Integrations); the workspace token isn't exported.");
    }

    return Object.keys(out).length ? out : null;
  }

  /* =========================================================================
   * 4. Top-level convert()
   * ====================================================================== */

  function convert(jsonText) {
    let apps = parseApps(jsonText);
    if (!apps.length) {
      throw new Error("No JSON object found. Paste the response from api.codemagic.io/apps/<id>.");
    }

    let todos = new Set();
    let blocks = [];
    let usedKeys = {};
    let count = 0;

    apps.forEach(function (app) {
      let application = app.application || app;
      let wfs = application.workflows || {};
      Object.keys(wfs).forEach(function (id) {
        count++;
        let wf = wfs[id];
        let key = slug((wf.name || "workflow") + " " + (application.appName || ""));
        usedKeys[key] = (usedKeys[key] || 0) + 1;
        if (usedKeys[key] > 1) key += "-" + usedKeys[key];

        let yObj = {};
        yObj[key] = convertWorkflow(wf, application, todos);
        let block = "  # App: " + (application.appName || "?") + "  ·  workflow _id: " + id + "\n" + emit(yObj, 1);
        blocks.push(block);
      });
    });

    if (!count) {
      throw new Error("Found JSON, but no `application.workflows` inside it. Is this the right API response?");
    }

    return { yaml: renderHeader(todos) + "workflows:\n" + blocks.join("\n"), count: count };
  }

  function renderHeader(todos) {
    let h =
      "# Generated from Codemagic UI config by codemagic-to-yaml v" + VERSION + ".\n" +
      "# https://github.com/<your-org>/codemagic-to-yaml\n" +
      "# Save as `codemagic.yaml` in your repo root.\n" +
      "# NOTE: secrets (passwords, uploaded keystores/keys, secure env values) are NOT in the\n" +
      "#       Codemagic API and cannot be exported. Resolve every TODO below before building.\n\n";
    if (todos.size) {
      h += "# ── TODO: set these up manually (not exportable) ──\n";
      todos.forEach(function (t) { h += "#   • " + t + "\n"; });
      h += "\n";
    }
    return h;
  }

  global.CodemagicConverter = { convert: convert, VERSION: VERSION };

  // Also export for Node (tests) — harmless in the browser where `module` is undefined.
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { convert: convert, VERSION: VERSION };
  }
})(typeof window !== "undefined" ? window : globalThis);
