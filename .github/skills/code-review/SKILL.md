---
name: code-review
description: Review Open Supermarkets pull requests for provider contract defects, inaccurate grocery data, store routing errors, unsafe account actions, and missing offline regression coverage.
---

# Review Open Supermarkets

Read the PR diff, relevant source, and nearby tests. Use `src/providers/types.ts`, `src/providers/registry.ts`, `package.json`, and `.github/workflows/ci.yml` as the branch's contract. Read shared provider and store helpers only when they exist and the change uses them.

## Provider and data checks

- Check that manifest capabilities match implemented methods. Optional operations need capability checks before use. Preserve lazy loading so provider discovery does not import every provider.
- Check product IDs, currency, finite prices, quantities, pagination, and malformed response handling. Preserve regular and member-only price distinctions. An empty catalogue response and a protocol failure must remain distinguishable.
- Where stock can be `boolean | null`, check all affected CLI, HTTP, and MCP consumers. Missing or conflicting retailer signals must remain unknown. Do not use a truthiness check that treats `null` as known out of stock.
- For store-scoped search, check retailer store IDs, request-local provider state, input validation, and selection before search. Concurrent requests must not share a mutable selected store.
- Check that invalid input, unsupported capabilities, authentication failure, and provider service failure have the intended public error behavior. Compare error handling with existing branch tests.

## Account and interface checks

- Check that basket, delivery slot, order, and checkout changes retain confirmation and dry-run controls. Never perform these operations on a live account during review.
- Check that cookies, tokens, account details, and payment data cannot enter logs, errors, fixtures, or review comments.
- Check that CLI aliases, HTTP payloads, MCP schemas, and JSON output remain compatible unless the PR explicitly changes the contract. Preserve Node.js 18 support and CommonJS package behavior.

## Verification and comments

Use existing offline tests for the changed flow. When execution is available and relevant, use `npm ci`, `npm run typecheck`, `npm run build`, and `npm test` after inspecting the scripts. CI also checks the published tarball. Do not add live retailer calls or secrets to CI.

Use available GitHub MCP read tools to resolve PR-linked issues and inspect checks when that context changes the review. Report unavailable context as a limit. Do not call write tools, request other reviews, or invoke Alibaba OCR from this skill.

For each finding, give severity, a changed line or affected path, a concrete trigger, the user-visible result, and a small correction. Report only actionable defects supported by source or tests. Avoid repeated findings and speculative style changes. Say which checks ran; do not claim that CI or live behavior passed without evidence.
