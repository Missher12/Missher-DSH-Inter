/** Trusted desktop authorization for one native browser attachment request. @module */

import type { Branded } from '@deepseek-ai/dsh-brand'

/** Random native authority identity bound to one exact live Agent activation. */
export type ComputerActivationId = string & Branded<'ComputerActivationId'>

/** Random identity for one pending native authorization request. */
export type ComputerAuthorizationRequestId = string & Branded<'ComputerAuthorizationRequestId'>

/** Content-bounded SDK request; resourceJson stays inside trusted Host/Desktop code. */
export interface ComputerAuthorizationRequest {
  requestId: ComputerAuthorizationRequestId
  sessionId: string
  activationId: ComputerActivationId
  requestDigest: string
  expiresAt: number
  summary: string
  resourceJson: string
}

/** A trusted desktop decision, never supplied by a model tool argument. */
export type ComputerAuthorizationDecision = 'allow' | 'deny' | 'cancel'

/** Trusted Host-to-Desktop adapter; it is independent of provider registration. */
export interface ComputerAuthorization {
  /**
   * Ask the user about exactly one attested browser/profile attachment.
   * @param request - SDK digest, expiry, activation, and trusted display fields.
   * @param signal - cancellation invalidates any late approval.
   * @returns a single decision; dismissal, expiry, and cancellation never allow.
   */
  request(request: ComputerAuthorizationRequest, signal: AbortSignal): Promise<ComputerAuthorizationDecision>
  /**
   * Cancel pending requests for an activation; native grants are revoked by SDK session close.
   * @param activationId - exact Host-lifetime activation being retired.
   * @returns after the adapter can no longer approve its pending requests.
   */
  revoke(activationId: ComputerActivationId): Promise<void>
}
