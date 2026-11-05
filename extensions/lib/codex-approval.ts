/**
 * The approval policy of a Codex worker.
 *
 * The policy decides when Codex asks the person for the approval of a
 * command. The protocol of the app server accepts the values of this list.
 * The setting `codex.approvalPolicy` in the configuration file names the
 * policy of a Codex worker.
 *
 * A missing value sends no field. The worker then keeps the policy of the
 * user, and the behavior of every running worker stays the same.
 */

/** The policies that the protocol of the app server accepts. */
export type ApprovalPolicy = "untrusted" | "on-request" | "never";

/** The policies that the protocol of the app server accepts. */
export const APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-request", "never"];

/** True when the value names a policy of the protocol. */
export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
	return typeof value === "string" && (APPROVAL_POLICIES as string[]).includes(value);
}

/**
 * The policy of a value, or null when the value names none.
 *
 * A missing value and an unknown value give null. Null means that the
 * extension sends no field, and the worker keeps the policy of the user.
 */
export function readApprovalPolicy(value: unknown): ApprovalPolicy | null {
	return isApprovalPolicy(value) ? value : null;
}

/** The text that refuses a value that names no policy. */
export function approvalPolicyRefusal(value: unknown): string {
	return (
		`The setting codex.approvalPolicy holds '${String(value)}', which names no policy. ` +
		`Use one of: ${APPROVAL_POLICIES.join(", ")}. ` +
		"The worker then keeps the policy of the user."
	);
}
