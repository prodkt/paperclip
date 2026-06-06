# MCP Access Governance Demo Script

This is the end-to-end demo for the MCP Access Governance launch. It walks the three required cases — **read**, **approval-gated write**, **denied/malicious** — against the bundled `paperclip.synthetic-todo-kv` fixture. The fixture ships in the Paperclip build; no upstream MCP server is required.

Audience: CTO sign-off, QA repro, and the recorded walkthrough that goes with the release notes. Time to run live: about 10 minutes.

Pair this script with [MCP-ACCESS-GOVERNANCE.md](./MCP-ACCESS-GOVERNANCE.md) for concepts and the full reference.

## Prerequisites

Before you start the recording:

- Paperclip running in `local_trusted` or `authenticated/private` mode. Public mode is fine for the demo as long as a trusted runtime host is configured (see [MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment](./MCP-ACCESS-GOVERNANCE.md#local-trusted-deployment)).
- A company with at least one agent identity to act as the caller.
- Board API key (`$BOARD_API_KEY`) exported. Company ID (`$COMPANY_ID`) exported. Agent ID (`$AGENT_ID`) for the caller exported.
- Paperclip URL (`$PAPERCLIP_URL`) exported.
- The Tools & Access UI open at `/<prefix>/companies/<companyId>/tools`.

The demo uses one terminal and one browser window side by side.

## Step 0 — Frame the demo

Spoken intro:

> "Paperclip ships with an MCP gateway that sits between every agent and every upstream tool. Three things happen on every call: we pick the tool against a profile, we evaluate policies, and we record an audit event. I'm going to run a read, then a write that needs approval, then a destructive call that gets denied. Everything you see is the bundled fixture — no upstream server is involved, so any failure is on us."

Show the Tools & Access overview tab. Point at:
- Applications count = 0
- Connections count = 0
- Slots = 0

## Step 1 — Install the example

Switch to the **Examples** tab. Click **Install** on *Safe read-only Todo / KV fixture*. The UI shows the application, connection, and profile being created.

API equivalent for the recording:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/examples/safe-read-only-todo-kv/install" \
  -d '{}' | jq '{applicationId, connectionId, profileId}'
```

Expected output: three IDs. Export them for the rest of the script:

```sh
export APPLICATION_ID=...   # from install response
export CONNECTION_ID=...
export PROFILE_ID=...
```

Quick check on the UI Catalog view: six tools listed, with `delete_item` flagged `destructive` and quarantined. Point at the quarantine badge.

## Step 2 — Bind the read-only profile to your demo agent

The example installs a profile that allows only the read-only tools (`list_items`, `get_value`). Bind it to the demo agent so the agent's effective profile is exactly that:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/$PROFILE_ID/bind" \
  -d '{ "targetType": "agent", "targetId": "'"$AGENT_ID"'", "priority": 10 }' | jq .

curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/profiles/effective/agents/$AGENT_ID" \
  | jq '{allowedToolNames}'
```

Expected: `allowedToolNames` contains `list_items` and `get_value`, nothing else.

## Step 3 — Open an agent session against the gateway

Get a gateway session token so the rest of the script can call as the agent:

```sh
SESSION=$(curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/sessions" \
  -d '{ "agentId": "'"$AGENT_ID"'" }')
export GATEWAY_TOKEN=$(jq -r '.token' <<<"$SESSION")
```

In production an agent gets this token through its run bootstrap. For the demo we mint one directly so the recording stays in one shell.

## Step 4 — The read tool (allowed)

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "toolName": "list_items", "arguments": {} }' \
  | jq '{decision: .decision, status: .status, result: .result}'
```

Expected: `decision: "allow"`, `status: "executed"`, a synthetic empty list in `result`.

Switch to the **Audit** tab in the UI. Refresh. The newest row is `call_allowed` for `list_items`, latency in single-digit ms. Point at it on the recording.

## Step 5 — The destructive tool (denied)

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "toolName": "delete_item", "arguments": { "id": "fake" } }' \
  | jq '{decision, status, reasonCode}'
```

Expected: `decision: "deny"`, `status: "denied"`, `reasonCode` one of `quarantined_catalog_entry` (because the catalog entry was quarantined on install) or `deny_default` (because the read-only profile does not include it). Either is the correct deny path.

The agent does not get a stack trace. The audit log gets a `call_denied` event with the reason code. Refresh the audit tab.

Spoken note:

> "The agent doesn't know whether the tool was denied by the profile, by a policy, or by quarantine. It just knows the call failed. The operator does — the reason code is in the audit row."

## Step 6 — Set up the approval-gated write tool

We are going to allow `create_item`, but require human approval for it. Two steps: extend the profile to *include* `create_item`, then add a `require_approval` policy targeting that tool.

Add `create_item` to the profile:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-profiles/$PROFILE_ID/entries" \
  -d '{ "selectorType": "tool_name", "selectorValue": "create_item", "effect": "include" }' \
  | jq '{id, selectorType, selectorValue, effect}'
```

Add a `require_approval` policy:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/policies" \
  -d '{
    "name": "Approve every create_item",
    "policyType": "require_approval",
    "priority": 100,
    "enabled": true,
    "selectors": { "toolNames": ["create_item"] },
    "config": { "approvalReason": "Demo: create_item requires approval." }
  }' | jq '{id, policyType, enabled}'
```

Dry-run the policy decision so the camera sees the engine respond with `require_approval`:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/policy/test" \
  -d '{ "agentId": "'"$AGENT_ID"'", "toolName": "create_item", "arguments": { "title": "Demo item" } }' \
  | jq '{decision, matchedPolicyIds, reasonCode}'
```

Expected: `decision: "require_approval"`, `matchedPolicyIds` includes the policy you just created.

## Step 7 — The agent call that triggers approval

```sh
CALL=$(curl -fsS -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "toolName": "create_item", "arguments": { "title": "Demo item" } }')
echo "$CALL" | jq '{decision, status, actionRequestId: .actionRequest.id, expiresAt: .actionRequest.expiresAt}'
export ACTION_REQUEST_ID=$(jq -r '.actionRequest.id' <<<"$CALL")
```

Expected: `decision: "require_approval"`, `status: "awaiting_approval"`, an action request ID and expiry.

In the UI, switch to the **Audit** tab and find the action request card (or go to the Action Requests view if your build exposes it as a separate tab). Point at the signed arguments, the requesting agent, the run, and the expiry. The agent's call is paused on this exact tool call until a decision lands.

## Step 8 — Approve the action

Approve via the API for the recording (the UI button does the same thing):

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/action-requests/$ACTION_REQUEST_ID/approve" \
  -d '{ "comment": "Approved for demo." }' | jq '{status, decidedAt, decidedByAgentId}'
```

Expected: `status: "approved"`. The agent call resumes server-side and the audit log gets two new rows: `call_allowed` and `call_completed` for the same invocation.

## Step 9 — Promote the approval to a trust rule (optional but useful)

Skip this on a 5-minute recording. Include it for the 10-minute version because it shows the operator-side automation story.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/action-requests/$ACTION_REQUEST_ID/trust-rule" \
  -d '{ "approvalThreshold": 10, "expiresAt": "2026-09-01T00:00:00.000Z" }' \
  | jq '{id, policyType, config: {trustRule: {approvalThreshold: .config.trustRule.approvalThreshold, hitCount: .config.trustRule.hitCount, expiresAt: .config.trustRule.expiresAt}}}'
```

Then call `create_item` again with the same argument shape:

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $GATEWAY_TOKEN" \
  -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-gateway/tools/call" \
  -d '{ "toolName": "create_item", "arguments": { "title": "Second demo item" } }' \
  | jq '{decision, status, matchedPolicyIds}'
```

Expected: `decision: "allow"` this time. The matched policy ID is the trust rule. Point at it.

Spoken note:

> "The trust rule covers up to ten approvals matching this argument shape. If the upstream tool changes its schema or the argument hash changes, the trust rule stops applying and we go back to approval. That's intentional — an approval is for a specific argument shape, not for the next version of the tool."

## Step 10 — Audit summary

Pull the full audit timeline for the demo:

```sh
curl -fsS \
  -H "Authorization: Bearer $BOARD_API_KEY" \
  "$PAPERCLIP_URL/api/tool-gateway/audit?companyId=$COMPANY_ID&limit=20" \
  | jq '[.[] | {createdAt, tool: .details.tool, decision: .details.decision, outcome: .details.outcome, reasonCode: .details.reasonCode}]'
```

Expected rows, newest first:

1. `create_item` — `allow` / `success` (trust rule hit, step 9)
2. `create_item` — `allow` / `success` (post-approval, step 8)
3. `create_item` — `require_approval` / `pending` (step 7)
4. `delete_item` — `deny` / `denied` with `reasonCode: deny_default` or `quarantined_catalog_entry` (step 5)
5. `list_items` — `allow` / `success` (step 4)

Close on the audit tab. Three required cases visible in a single screen. End of recording.

## Cleanup (optional)

If you ran the demo on a long-lived environment, leave the example installed — the bundled smoke (`POST …/examples/safe-read-only-todo-kv/smoke`) replays the three cases on demand. If you need a clean state:

```sh
# Revoke the trust rule (if you created one)
curl -fsS -X POST -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/companies/$COMPANY_ID/tools/trust-rules/$TRUST_RULE_POLICY_ID/revoke" \
  -d '{ "reason": "Demo cleanup." }' | jq '{id, enabled}'

# Disable the connection
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-connections/$CONNECTION_ID" \
  -d '{ "enabled": false, "status": "disabled" }' | jq '{id, enabled, status}'

# Archive the application
curl -fsS -X PATCH -H "Authorization: Bearer $BOARD_API_KEY" -H "Content-Type: application/json" \
  "$PAPERCLIP_URL/api/tool-applications/$APPLICATION_ID" \
  -d '{ "status": "archived" }' | jq '{id, status}'
```

Audit history is retained; the connection and application stay archived for the record.

## What this proves

- **Read** path: the read-only catalog entry, the read-only profile, and the gateway audit row line up.
- **Approval-gated write** path: profile inclusion + `require_approval` policy + action request + human approve + audit closure. Trust rule promotion bridges the human-in-the-loop step to a steady-state allow without losing the audit trail.
- **Denied / destructive** path: catalog quarantine on first sight, profile default-deny, and a clean `deny` decision with reason code at the gateway. The agent sees a failed call; the operator sees the reason.

This is the contract the launch ships. If a future change loosens any of these — silent allow on a destructive tool, an approval that doesn't audit, a denied call without a reason code — the demo will fail and so will QA.
