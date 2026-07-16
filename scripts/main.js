/**
 * codemagic-to-yaml — app layer (DOM wiring only).
 *
 * All conversion logic lives in converter.js. This file only reads the input,
 * calls CodemagicConverter.convert(), and renders the result.
 */
(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  const els = {
    input: $("input"),
    output: $("output"),
    convert: $("convert"),
    download: $("download"),
    copy: $("copy"),
    file: $("file"),
    msg: $("msg"),
    version: $("version"),
  };

  // --- status banner -------------------------------------------------------
  function showMsg(text, ok) {
    els.msg.textContent = text;
    els.msg.className =
      "rounded-lg px-4 py-3 text-sm border " +
      (ok
        ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-800 dark:text-emerald-200"
        : "bg-red-500/10 border-red-500/40 text-red-800 dark:text-red-200");
    els.msg.classList.remove("hidden");
  }

  function setOutputEnabled(on) {
    els.download.disabled = !on;
    els.copy.disabled = !on;
  }

  // --- core action ---------------------------------------------------------
  function runConvert() {
    try {
      const result = window.CodemagicConverter.convert(els.input.value);
      els.output.textContent = result.yaml;
      setOutputEnabled(true);
      showMsg(
        "Converted " + result.count + " workflow" + (result.count === 1 ? "" : "s") +
        ". Review the TODOs at the top, then commit as codemagic.yaml.",
        true
      );
    } catch (e) {
      els.output.textContent = "";
      setOutputEnabled(false);
      showMsg("Error: " + e.message, false);
    }
  }

  function loadFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function () { els.input.value = reader.result; runConvert(); };
    reader.readAsText(file);
  }

  // --- wiring --------------------------------------------------------------
  els.convert.addEventListener("click", runConvert);

  els.download.addEventListener("click", function () {
    const blob = new Blob([els.output.textContent], { type: "text/yaml" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "codemagic.yaml";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  els.copy.addEventListener("click", function () {
    navigator.clipboard.writeText(els.output.textContent);
    showMsg("Copied to clipboard.", true);
  });

  els.file.addEventListener("change", function (e) { loadFile(e.target.files[0]); });

  // drag-and-drop onto either panel
  ["input", "output"].forEach(function (id) {
    const el = els[id];
    el.addEventListener("dragover", function (e) { e.preventDefault(); el.classList.add("ring-2", "ring-sky-400"); });
    el.addEventListener("dragleave", function () { el.classList.remove("ring-2", "ring-sky-400"); });
    el.addEventListener("drop", function (e) {
      e.preventDefault();
      el.classList.remove("ring-2", "ring-sky-400");
      loadFile(e.dataTransfer.files[0]);
    });
  });

  // footer version
  if (els.version) els.version.textContent = "v" + window.CodemagicConverter.VERSION;

  // --- self-check: open index.html?selftest -------------------------------
  if (location.search.indexOf("selftest") >= 0) runSelfTest();

  function runSelfTest() {
    const sample = JSON.stringify({
      application: {
        appName: "a",
        workflows: {
          WF1: {
            _id: "WF1", name: "Default Workflow", instanceType: "mac_mini_m2", maxBuildDuration: 2700,
            testRunners: { flutterAnalyze: {}, flutterTest: {}, stopBuildIfTestsFail: true },
            publishers: {
              email: { recipients: ["x@y.com"], enabled: true },
              googlePlay: { credentials: { filePath: "0e5b0025-c7f9-4c5a-bbfa-71a81a8b80cd/x", fileName: "k.json" }, track: "internal", submitAsDraft: true, enabled: true },
            },
            codeSigning: {
              android: { enabled: true, keystorePassword: "********", keystore: { filePath: "059bc5bc-2d2c-4e15-8fc2-7858aef9ec39/y", fileName: "release-keystore.jks" } },
              ios: { enabled: true, developerPortalBundleIdentifier: "com.q.rider", developerPortalProfileType: "app_store" },
            },
            customScripts: { postClone: "flutter pub get" },
            buildSettings: {
              automaticBuilds: true, cancelPreviousBuilds: false, platforms: ["android", "ios"],
              flutterVersion: "3.35.7", androidBuildOutputFormat: "aab",
              androidBuildArguments: "-t lib/main_prod.dart", iosBuildArguments: "-t lib/main_prod.dart",
              shorebird: { enabled: true },
            },
            environmentVariables: [{ name: "BASE_URL", value: "https://api.example.com/v1", secure: false }],
          },
        },
      },
    });
    const r = window.CodemagicConverter.convert(sample);
    const yaml = r.yaml;
    const assert = function (c, m) { if (!c) throw new Error("SELFTEST FAIL: " + m); };
    try {
      assert(r.count === 1, "workflow count");
      assert(yaml.indexOf("max_build_duration: 45") >= 0, "2700s -> 45min");
      assert(yaml.indexOf("********") < 0, "password leaked");
      assert(!/\.jks|-c7f9-|-533e-/.test(yaml), "uploaded file path leaked");
      assert(yaml.indexOf('"https://api.example.com/v1"') >= 0, "URL not quoted");
      assert(yaml.indexOf("flutter analyze") >= 0 && yaml.indexOf("flutter test") >= 0, "test steps");
      assert(yaml.indexOf("android_signing") >= 0 && yaml.indexOf("google_play") >= 0 && yaml.indexOf("app_store_connect") >= 0, "refs present");
      assert(yaml.indexOf("bundle_identifier: com.q.rider") >= 0, "ios bundle id");
      console.log("SELFTEST PASSED ✅\n\n" + yaml);
      els.input.value = sample;
      els.output.textContent = yaml;
      setOutputEnabled(true);
      showMsg("Self-test passed ✅ — see console for the generated YAML.", true);
    } catch (e) {
      console.error(e);
      showMsg(e.message, false);
    }
  }
})();
