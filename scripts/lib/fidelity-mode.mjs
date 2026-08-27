// Fidelity leniency switch for the reconstructed fork.
//
// The original reconstruction enforced a strict invariant: every visible UI
// string, renderer feature surface, route, and asset byte had to trace back to
// the immutable shipped Grok Bot 0.18 chunks. That invariant is what turns any
// UI edit into a hard build failure ("renderer UI provenance is not green",
// "closure no longer covers the exact 5 feature surfaces", etc.).
//
// This fork deliberately diverges from the shipped app (rebrand, new UI), so by
// default those fidelity/provenance/closure/asset-hash gates are advisory:
// they print a warning and let the build proceed. Set MENGEL_STRICT_FIDELITY=1
// to restore the original hard-failing behavior.

export const STRICT_FIDELITY = (process.env.MENGEL_STRICT_FIDELITY ?? "").trim() === "1";

// Throw in strict mode, warn otherwise. `ok` true means the invariant holds and
// nothing happens. Use for fidelity/provenance/hash equality checks that should
// no longer block a divergent build.
export function fidelityAssert(ok, message) {
  if (ok) return;
  if (STRICT_FIDELITY) throw new Error(message);
  console.warn(`[fidelity:lenient] ${message}`);
}
