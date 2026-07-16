"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { convert, VERSION } = require("../scripts/converter.js");

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// A full-featured workflow that exercises every mapping + every secret type.
function fullApp(overrides) {
  const wf = Object.assign(
    {
      _id: "WF1",
      name: "Default Workflow",
      instanceType: "mac_mini_m2",
      maxBuildDuration: 2700, // seconds -> 45 min
      testRunners: { flutterAnalyze: {}, flutterTest: {}, stopBuildIfTestsFail: true },
      branchPatterns: [["production", true, "target"]],
      publishers: {
        email: { recipients: ["dev@example.com"], enabled: true },
        googlePlay: {
          credentials: { filePath: "0e5b0025-c7f9-4c5a-bbfa-71a81a8b80cd/x", fileName: "sa.json" },
          track: "internal",
          submitAsDraft: true,
          enabled: true,
        },
        appStoreConnect: { enabled: true, submitToTestflight: true },
      },
      codeSigning: {
        android: {
          enabled: true,
          keystorePassword: "********",
          keystore: { filePath: "059bc5bc-2d2c-4e15-8fc2-7858aef9ec39/y", fileName: "release-keystore.jks" },
        },
        ios: { enabled: true, developerPortalBundleIdentifier: "com.q.rider", developerPortalProfileType: "app_store" },
      },
      customScripts: { postClone: "flutter pub get" },
      buildSettings: {
        automaticBuilds: true,
        cancelPreviousBuilds: true,
        platforms: ["android", "ios"],
        flutterVersion: "3.35.7",
        xcodeVersion: "latest",
        cocoapodsVersion: "default",
        androidBuildOutputFormat: "aab",
        androidBuildArguments: "-t lib/main_prod.dart",
        iosBuildArguments: "-t lib/main_prod.dart",
        shorebird: { enabled: true },
      },
      environmentVariables: [
        { name: "BASE_URL", value: "https://api.example.com/v1", secure: false },
        { name: "API_SECRET", value: "shh", secure: true },
      ],
    },
    overrides || {}
  );
  return JSON.stringify({ application: { appName: "rider", workflows: { WF1: wf } } });
}

function convertFull(overrides) {
  return convert(fullApp(overrides)).yaml;
}

/* ------------------------------------------------------------------ */
/* Contract                                                           */
/* ------------------------------------------------------------------ */

test("convert returns { yaml, count } and VERSION is a string", () => {
  const r = convert(fullApp());
  assert.equal(typeof r.yaml, "string");
  assert.equal(r.count, 1);
  assert.equal(typeof VERSION, "string");
  assert.match(r.yaml, /codemagic-to-yaml v/);
});

/* ------------------------------------------------------------------ */
/* Secrets never leak — the critical guarantee                        */
/* ------------------------------------------------------------------ */

test("no secret ever appears in the output", () => {
  const yaml = convertFull();
  assert.ok(!yaml.includes("********"), "masked password leaked");
  assert.ok(!yaml.includes(".jks"), "keystore filename leaked");
  assert.ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-/.test(yaml), "uploaded-file UUID path leaked");
  assert.ok(!yaml.includes('"shh"') && !/API_SECRET: shh/.test(yaml), "secure env value leaked");
});

/* ------------------------------------------------------------------ */
/* Units                                                              */
/* ------------------------------------------------------------------ */

test("max_build_duration converts seconds to minutes", () => {
  assert.match(convertFull({ maxBuildDuration: 2700 }), /max_build_duration: 45\b/);
  assert.match(convertFull({ maxBuildDuration: 4500 }), /max_build_duration: 75\b/);
});

test("non-secure env var goes to vars with a quoted URL value", () => {
  const yaml = convertFull();
  assert.match(yaml, /vars:/);
  assert.match(yaml, /BASE_URL: "https:\/\/api\.example\.com\/v1"/);
});

test("secure env var goes to groups, not vars", () => {
  const yaml = convertFull();
  assert.match(yaml, /groups:/);
  assert.match(yaml, /- API_SECRET/);
  assert.ok(!/API_SECRET:/.test(yaml), "secure var should not be emitted as a var key");
});

test("android signing emits keystore_reference", () => {
  const yaml = convertFull();
  assert.match(yaml, /android_signing:\n\s+- keystore_reference/);
});

test("ios signing emits distribution_type and bundle_identifier", () => {
  const yaml = convertFull();
  assert.match(yaml, /ios_signing:/);
  assert.match(yaml, /distribution_type: app_store/);
  assert.match(yaml, /bundle_identifier: com\.q\.rider/);
});

test("google play publishing + group + placeholder credentials", () => {
  const yaml = convertFull();
  assert.match(yaml, /google_play:/);
  assert.match(yaml, /credentials: "\$GOOGLE_PLAY_SERVICE_ACCOUNT_CREDENTIALS"/);
  assert.match(yaml, /track: internal/);
  assert.match(yaml, /submit_as_draft: true/);
  assert.match(yaml, /- google_play/); // added to environment.groups
});

test("email recipients and app_store_connect refs", () => {
  const yaml = convertFull();
  assert.match(yaml, /email:\n\s+recipients:\n\s+- dev@example\.com/);
  assert.match(yaml, /app_store_connect:/);
  assert.match(yaml, /api_key: "\$APP_STORE_CONNECT_PRIVATE_KEY"/);
  assert.match(yaml, /submit_to_testflight: true/);
});

test("triggering: events, branch_patterns, cancel_previous_builds", () => {
  const yaml = convertFull();
  assert.match(yaml, /triggering:/);
  assert.match(yaml, /events:\n\s+- push/);
  assert.match(yaml, /branch_patterns:\n\s+- pattern: production\n\s+include: true\n\s+target: true/);
  assert.match(yaml, /cancel_previous_builds: true/);
});

test("scripts: post-clone, analyze, test, and build steps with args", () => {
  const yaml = convertFull();
  assert.match(yaml, /name: Post-clone/);
  assert.match(yaml, /flutter pub get/);
  assert.match(yaml, /name: "Flutter analyze"[\s\S]*flutter analyze/);
  assert.match(yaml, /flutter test/);
  assert.match(yaml, /flutter build appbundle --release -t lib\/main_prod\.dart/);
  assert.match(yaml, /flutter build ipa --release -t lib\/main_prod\.dart/);
});

test("flutter test gets ignore_failure when stopBuildIfTestsFail is false", () => {
  const yaml = convertFull({ testRunners: { flutterTest: {}, stopBuildIfTestsFail: false } });
  assert.match(yaml, /name: "Flutter unit tests"[\s\S]*ignore_failure: true/);
});

test("artifacts: aab by default, apk when androidBuildOutputFormat is apk", () => {
  assert.match(convertFull(), /build\/\*\*\/outputs\/\*\*\/\*\.aab/);
  const apk = convertFull({
    buildSettings: {
      platforms: ["android"], flutterVersion: "3.35.7", androidBuildOutputFormat: "apk", automaticBuilds: true,
    },
  });
  assert.match(apk, /\*\.apk/);
  assert.ok(!apk.includes("*.aab"), "should not emit aab when apk selected");
});

test("shorebird enabled adds a TODO to the header", () => {
  assert.match(convertFull(), /Shorebird is enabled/);
});

/* ------------------------------------------------------------------ */
/* YAML formatting invariants (dependency-free parser stand-in)       */
/* ------------------------------------------------------------------ */

test("no list item has a missing space after the dash", () => {
  const yaml = convertFull();
  // every "- " list item must have whitespace after the dash; catch "-foo"
  assert.ok(!/^\s*-\S/m.test(yaml), "found a dash with no following space (invalid YAML)");
});

test("multi-line scripts use a block scalar", () => {
  const yaml = convertFull({ customScripts: { postClone: "line1\nline2" } });
  assert.match(yaml, /script: \|\n\s+line1\n\s+line2/);
});

test("values with special chars are quoted, plain values are not", () => {
  const yaml = convertFull();
  assert.match(yaml, /instance_type: mac_mini_m2/); // plain, unquoted
  assert.match(yaml, /"https:\/\/api\.example\.com\/v1"/); // has ':' -> quoted
});

/* ------------------------------------------------------------------ */
/* Multi-app parsing                                                  */
/* ------------------------------------------------------------------ */

test("two concatenated objects with // comments parse to two workflows", () => {
  const blob =
    "// https://api.codemagic.io/apps/1\n" + fullApp() + "\n\n" +
    "// https://api.codemagic.io/apps/2\n" +
    JSON.stringify({ application: { appName: "driver", workflows: { WF2: { _id: "WF2", name: "Default Workflow", buildSettings: { platforms: ["android"] } } } } });
  const r = convert(blob);
  assert.equal(r.count, 2);
  assert.match(r.yaml, /default-workflow-rider:/);
  assert.match(r.yaml, /default-workflow-driver:/);
});

test("duplicate workflow keys get a numeric suffix", () => {
  const one = { application: { appName: "app", workflows: { A: { _id: "A", name: "Build", buildSettings: { platforms: [] } } } } };
  const two = { application: { appName: "app", workflows: { B: { _id: "B", name: "Build", buildSettings: { platforms: [] } } } } };
  const r = convert(JSON.stringify(one) + "\n" + JSON.stringify(two));
  assert.equal(r.count, 2);
  assert.match(r.yaml, /build-app:/);
  assert.match(r.yaml, /build-app-2:/);
});

/* ------------------------------------------------------------------ */
/* Added coverage: new mappings                                       */
/* ------------------------------------------------------------------ */

test("flutterDrive becomes an integration test step", () => {
  const yaml = convertFull({ testRunners: { flutterDrive: { frameworkType: "flutter_driver" } } });
  assert.match(yaml, /name: "Flutter integration tests"[\s\S]*flutter drive --target=/);
});

test("dependencyCache maps to cache.cache_paths (only when non-empty)", () => {
  assert.ok(!convertFull().includes("cache_paths"), "empty cache should emit nothing");
  const yaml = convertFull({ dependencyCache: { enabled: true, cachePaths: ["$HOME/.pub-cache", "$HOME/.gradle/caches"] } });
  // values with `$` are quoted
  assert.match(yaml, /cache:\n\s+cache_paths:\n\s+- "\$HOME\/\.pub-cache"\n\s+- "\$HOME\/\.gradle\/caches"/);
});

test("tagPatterns map to triggering.tag_patterns", () => {
  const yaml = convertFull({ tagPatterns: [["v*", true]] });
  assert.match(yaml, /tag_patterns:\n\s+- pattern: "v\*"\n\s+include: true/);
});

test("flutterMode and flutterVerbose change the build flags", () => {
  const yaml = convertFull({
    buildSettings: { platforms: ["android"], androidBuildOutputFormat: "apk", flutterMode: "debug", flutterVerbose: true },
  });
  assert.match(yaml, /flutter build apk --debug --verbose/);
});

test("macOS / windows / web platforms produce build steps and artifacts", () => {
  const yaml = convertFull({ buildSettings: { platforms: ["macos", "windows", "web"] } });
  assert.match(yaml, /flutter build macos --release/);
  assert.match(yaml, /flutter build windows --release/);
  assert.match(yaml, /flutter build web --release/);
  assert.match(yaml, /build\/macos\/\*\*\/\*\.app/);
  assert.match(yaml, /build\/web\/\*\*/);
});

test("firebase publishing maps app_ids, groups and a service-account placeholder", () => {
  const yaml = convertFull({
    publishers: {
      firebase: { enabled: true, android: { appId: "1:android", groups: ["testers"] }, ios: { appId: "1:ios", groups: [] } },
    },
  });
  assert.match(yaml, /firebase:\n\s+firebase_service_account: "\$FIREBASE_SERVICE_ACCOUNT"/);
  assert.match(yaml, /android:\n\s+app_id: "1:android"\n\s+groups:\n\s+- testers/);
  assert.match(yaml, /ios:\n\s+app_id: "1:ios"/);
});

test("slack publishing maps the channel when configured", () => {
  const yaml = convertFull({ publishers: { slack: { enabled: true, channel: "#builds" } } });
  assert.match(yaml, /slack:\n\s+channel: "#builds"/);
});

test("app_store_connect extras: release_type and beta_groups", () => {
  const yaml = convertFull({
    publishers: { appStoreConnect: { enabled: true, releaseType: "MANUAL", submitToBetaGroups: true, betaGroups: ["QA"] } },
  });
  assert.match(yaml, /release_type: MANUAL/);
  assert.match(yaml, /beta_groups:\n\s+- QA/);
});

test("google_play extras: rollout_fraction and changes_not_sent_for_review", () => {
  const yaml = convertFull({
    publishers: { googlePlay: { enabled: true, track: "production", rolloutFraction: 0.25, changesNotSentForReview: true } },
  });
  assert.match(yaml, /rollout_fraction: 0\.25/);
  assert.match(yaml, /changes_not_sent_for_review: true/);
});

test("app-level environment variables merge into each workflow", () => {
  const blob = JSON.stringify({
    application: {
      appName: "app",
      appEnvironmentVariables: { variables: [{ name: "SHARED", value: "yes", secure: false }], groups: ["shared_group"] },
      workflows: { A: { _id: "A", name: "Build", buildSettings: { platforms: [] } } },
    },
  });
  const { yaml } = convert(blob);
  assert.match(yaml, /SHARED: "yes"/); // "yes" is a YAML reserved word -> quoted
  assert.match(yaml, /- shared_group/);
});

/* ------------------------------------------------------------------ */
/* Errors                                                             */
/* ------------------------------------------------------------------ */

test("empty or non-JSON input throws", () => {
  assert.throws(() => convert(""), /No JSON object/);
  assert.throws(() => convert("not json at all"), /No JSON object/);
});

test("JSON without application.workflows throws", () => {
  assert.throws(() => convert(JSON.stringify({ hello: "world" })), /no `application\.workflows`/);
});
