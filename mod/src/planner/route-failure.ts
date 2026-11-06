// Shared route-failure shape (B157 phase 2). Both transports already know whether a search failed and how much work it
// spent; only the belt had a structured seal proof and evidence. One failure type lets the evidence, the remedies
// (`tryReplace`, relocation) and the retry policy read the same thing, whatever the transport.

import type { SealProof } from "./route-seal"

export type RouteFailureKind = "no-path" | "sealed" | "budget"

export interface RouteFailure {
  kind: RouteFailureKind
  /** The search's own reason, for the failure message and diagnostics. */
  reason: string
  /** Work spent (expansions). */
  work: number
  /** A proved seal, when the flood could prove one (with `edge` set when it was not a proof). */
  sealed?: SealProof
}
