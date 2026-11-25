// Shared catalog state + label registry. ES module live-bindings mean imports
// stay in sync after setAppLabels reassigns the underlying array.

export const DEFAULT_LABEL = "nucleus";
// Псевдо-модель «ручна розмітка» (backend state.ManualModelSource): порожня маска,
// усе малюється полігонами. Доступна для кожного фото.
export const MANUAL_MODEL = "manual";
export const MANUAL_MODEL_TITLE = "✋ Ручна розмітка";

export const state = {
  catalog: [],
  models: [],
  config: null,
  filter: "all",
  idx: 0,
  user: "",
};

export let appLabels = [];
export function setAppLabels(arr) { appLabels = arr; }

// Набори класів на фото (label_sets.json, бекенд label_sets.py): stem → [назви].
// Для фото з набором у редакторі доступні ЛИШЕ його класи (клавіші 1..N за порядком
// набору); фото без набору (старі дані) — усі класи labels.json.
export let stemLabelSets = {};
export function setStemLabelSets(obj) { stemLabelSets = obj || {}; }
export function usableLabels(stem) {
  const names = stem && stemLabelSets[stem];
  if (!names || !names.length) return appLabels;
  const out = [];
  names.forEach((n) => {
    const l = appLabels.find((x) => x.name === n);
    if (l) out.push({ ...l, shortcut: out.length < 9 ? String(out.length + 1) : "" });
  });
  return out.length ? out : appLabels;
}

export function filtered() {
  if (state.filter === "all") {
    return state.catalog.filter((it) => !(it.state && it.state.status === "excluded"));
  }
  return state.catalog.filter((it) => {
    const st = it.state && it.state.status;
    if (state.filter === "unreviewed") {
      return !st || st === "" || (st !== "selected" && st !== "skipped" && st !== "excluded");
    }
    return st === state.filter;
  });
}

export function currentItem() {
  const list = filtered();
  if (!list.length) return null;
  if (state.idx >= list.length) state.idx = list.length - 1;
  if (state.idx < 0) state.idx = 0;
  return list[state.idx];
}

export function getLabelByName(name) {
  return appLabels.find((l) => l.name === name)
    || appLabels[0]
    || { name: "nucleus", color: "#4488ff", shortcut: "1" };
}

export function getLabelColor(name) {
  return getLabelByName(name).color || "#4488ff";
}
