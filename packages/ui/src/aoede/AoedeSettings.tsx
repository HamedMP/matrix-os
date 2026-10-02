"use client";

import { useEffect, useId, useState } from "react";
import type { CanonicalProviderCatalog } from "@matrix-os/contracts";
import type { VoiceSessionDevice } from "../voice-session/client-types.js";
import type { AoedeController, AoedeSnapshot } from "./controller.js";
import { boundedAoedeText } from "./presentation.js";
import { AOEDE_SPEECH_LANGUAGES } from "./preferences.js";

export interface AoedeSettingsProps {
  controller: AoedeController;
  snapshot: AoedeSnapshot;
}

/**
 * Aoede settings: turn mode, spoken language, model and voice input/output
 * devices. All mutations route through the controller — canonical revision
 * fencing, media rebuilding and persistence live there, never in the view.
 */
export function AoedeSettings({ controller, snapshot }: AoedeSettingsProps) {
  const id = useId();
  const [catalog, setCatalog] = useState<CanonicalProviderCatalog | "loading" | null>("loading");
  const [devices, setDevices] = useState<VoiceSessionDevice[] | "loading" | null>("loading");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const selection = snapshot.binding?.selection;
  const capability = snapshot.binding?.capability;
  const boundInstance = snapshot.boundProviderInstanceId;

  const reloadCatalog = () => {
    setCatalog("loading");
    void controller.listProviders().then(setCatalog);
  };
  useEffect(reloadCatalog, [controller]);
  useEffect(() => {
    setDevices("loading");
    void controller.listDevices().then(setDevices);
  }, [controller, snapshot.devicesRevision, snapshot.binding]);

  const instance = catalog !== "loading" && catalog !== null
    ? catalog.instances.find(item => item.id === (boundInstance ?? selection?.instanceId)) ?? null
    : null;
  const availableModels = (instance?.models ?? []).filter(model => model.availability === "available").slice(0, 64);
  const savedModelUnavailable = Boolean(selection?.model && !availableModels.some(model => model.id === selection.model));
  const inputs = devices !== "loading" && devices !== null ? devices.filter(device => device.kind === "audioinput").slice(0, 32) : [];
  const outputs = devices !== "loading" && devices !== null ? devices.filter(device => device.kind === "audiooutput").slice(0, 32) : [];
  const turnModes = capability?.turnModes ?? ["hands_free", "push_to_talk"];
  const run = (key: string, work: Promise<unknown>, revert?: () => void) => {
    if (busy) return;
    setBusy(key); setNote(null);
    void work.then((result) => { if (result === false || result === null || result === "unavailable") revert?.(); }).finally(() => setBusy(null));
  };

  return <div className="matrix-aoede-settings">
    <fieldset className="matrix-aoede-settings__group" disabled={busy === "turn_mode"}>
      <legend className="matrix-aoede-settings__legend">Turn mode</legend>
      {turnModes.map(mode => <label key={mode} className="matrix-aoede-settings__option">
        <input type="radio" name={`${id}-turn`} checked={snapshot.turnMode === mode}
          onChange={() => run("turn_mode", controller.setTurnMode(mode))} />
        <span>{mode === "push_to_talk" ? "Push to talk" : "Hands free"}</span>
      </label>)}
      <p className="matrix-aoede-settings__hint">Changing the mode ends any live voice session so the next Start applies it.</p>
    </fieldset>

    <fieldset className="matrix-aoede-settings__group" disabled={busy === "language"}>
      <legend className="matrix-aoede-settings__legend">Recognition</legend>
      <label className="matrix-aoede-settings__field">
        <span>Spoken language</span>
        <select value={snapshot.preferredLanguage} aria-describedby={`${id}-language-hint`}
          onChange={(event) => run("language", controller.setPreferredLanguage(event.target.value))}>
          {AOEDE_SPEECH_LANGUAGES.map(language => <option key={language.code} value={language.code}>{language.label}</option>)}
        </select>
      </label>
      <p id={`${id}-language-hint`} className="matrix-aoede-settings__hint">Choose the language you speak to reduce detection mistakes. Automatic detects each turn. Changing it ends the live voice session.</p>
    </fieldset>

    <fieldset className="matrix-aoede-settings__group" disabled={busy === "selection"}>
      <legend className="matrix-aoede-settings__legend">Model</legend>
      {catalog === "loading" ? <p className="matrix-aoede-settings__hint">Loading providers…</p> : null}
      {catalog === null ? <div className="matrix-aoede-settings__row">
        <p className="matrix-aoede-settings__hint" role="status">Provider list unavailable.</p>
        <button type="button" className="matrix-aoede__button" onClick={reloadCatalog}>Reload</button>
      </div> : null}
      {catalog !== "loading" && catalog !== null ? <>
        <label className="matrix-aoede-settings__field">
          <span>Provider</span>
          <select value={instance?.id ?? ""} disabled={busy === "selection" || boundInstance !== null}
            onChange={(event) => {
              const next = catalog.instances.find(item => item.id === event.target.value);
              const model = next?.defaultSelection?.model ?? next?.models.find(item => item.availability === "available")?.id;
              if (!next || !model || !selection) return;
              run("selection", controller.setSelection({ instanceId: next.id, model }));
            }}>
            {instance === null ? <option value="" disabled>Choose provider</option> : null}
            {catalog.instances.filter(item => item.availability === "available").slice(0, 64).map(item =>
              <option key={item.id} value={item.id}>{boundedAoedeText(item.displayName, 80)}</option>)}
          </select>
        </label>
        {boundInstance !== null ? <p className="matrix-aoede-settings__hint">The provider is locked to this conversation while runs are bound to it.</p> : null}
        <label className="matrix-aoede-settings__field">
          <span>Model</span>
          <select value={selection?.model ?? ""} disabled={busy === "selection" || !instance}
            onChange={(event) => {
              const model = event.target.value;
              if (!instance || !model || !selection) return;
              run("selection", controller.setSelection({ instanceId: instance.id, model }));
            }}>
            {savedModelUnavailable ? <option value={selection!.model} disabled>Saved model unavailable</option> : null}
            {availableModels.length === 0 ? <option value="" disabled>No available models</option> : null}
            {availableModels.map(model => <option key={model.id} value={model.id}>{boundedAoedeText(model.displayName, 80)}</option>)}
          </select>
        </label>
        {savedModelUnavailable ? <p className="matrix-aoede-settings__hint">The saved model is unavailable. Choose an available model to restore voice.</p> : null}
      </> : null}
    </fieldset>

    <fieldset className="matrix-aoede-settings__group" disabled={busy === "input" || busy === "output"}>
      <legend className="matrix-aoede-settings__legend">Devices</legend>
      {devices === "loading" ? <p className="matrix-aoede-settings__hint">Loading devices…</p> : null}
      {devices === null ? <p className="matrix-aoede-settings__hint" role="status">Device list unavailable. Enumeration may be denied or unsupported; saved choices are kept.</p> : null}
      {devices !== "loading" && devices !== null ? <>
        <label className="matrix-aoede-settings__field">
          <span>Voice input</span>
          <select value={snapshot.inputDeviceId ?? ""} disabled={capability?.supportsInputSelection === false}
            onChange={(event) => run("input", controller.setInputDevice(event.target.value || null).then((result) => {
              if (!result) { setNote("Voice input could not be applied; the saved choice still applies to the next session."); }
              return result;
            }))}>
            <option value="">System default</option>
            {inputs.map(device => <option key={device.deviceId} value={device.deviceId}>{boundedAoedeText(device.label || device.deviceId, 80)}</option>)}
            {snapshot.inputDeviceId && !inputs.some(device => device.deviceId === snapshot.inputDeviceId)
              ? <option value={snapshot.inputDeviceId}>Saved device</option> : null}
          </select>
        </label>
        <label className="matrix-aoede-settings__field">
          <span>Audio output</span>
          <select value={snapshot.outputDeviceId ?? ""} disabled={capability?.supportsOutputSelection === false}
            onChange={(event) => run("output", controller.setOutputDevice(event.target.value || null).then((result) => {
              if (result === "unsupported") { setNote("Output routing is not supported in this browser."); return result; }
              if (result === "unavailable") { setNote("Audio output could not be applied; the saved choice still applies to the next session."); }
              return result;
            }))}>
            <option value="">System default</option>
            {outputs.map(device => <option key={device.deviceId} value={device.deviceId}>{boundedAoedeText(device.label || device.deviceId, 80)}</option>)}
            {snapshot.outputDeviceId && !outputs.some(device => device.deviceId === snapshot.outputDeviceId)
              ? <option value={snapshot.outputDeviceId}>Saved device</option> : null}
          </select>
        </label>
      </> : null}
      {capability?.supportsInputSelection === false || capability?.supportsOutputSelection === false
        ? <p className="matrix-aoede-settings__hint">Device selection is not supported on this surface.</p> : null}
      {note ? <p className="matrix-aoede-settings__hint" role="status">{note}</p> : null}
    </fieldset>
  </div>;
}
