/**
 * The one place that decides who may download a catalogue file. Everyone may,
 * today. Gating later (sign-in, credits, premium packs) changes this function
 * only; the download route already answers 403 when it says no.
 */
export function canDownload(_asset: { id: string }): boolean {
  return true;
}
