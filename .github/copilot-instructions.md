# Open Supermarkets review context

Open Supermarkets is a TypeScript grocery CLI, HTTP API, and MCP server. Node.js 18 and later are supported. Package output uses CommonJS. Keep existing command aliases and public JSON contracts compatible.

For pull request reviews, use `.github/skills/code-review/SKILL.md`. Read the actual contract and tests on the PR head branch. Features differ between branches; do not require a provider or helper that the branch does not contain.

Report defects introduced by the change. Give the affected path, a precise trigger, its user impact, and a small correction. Focus on bugs, security, data accuracy, and missing regression coverage. Avoid style comments, broad refactors, and claims based only on a hypothetical use case.

Provider manifests describe supported capabilities. Search-only providers are valid. Keep registry loading lazy. Do not infer basket or checkout support from catalogue search.

Preserve `in_stock: null` where the branch supports unknown stock. Unknown stock does not mean available or unavailable. Preserve currency, product identity, store scope, and the source of price data. Do not replace missing or malformed retailer data with invented prices or a successful empty result.

Keep offline CI separate from live retailer checks. Use the current package scripts and CI workflow for validation. Do not use customer credentials or make live basket, slot, order, or checkout changes during review.

Use available GitHub MCP read tools for linked issues, PR context, and checks when relevant. Local Copilot CLI settings and local Alibaba Open Code Review credentials are not available in GitHub's review environment. Do not install or invoke another LLM reviewer as a prerequisite.

Write short, plain English comments. State what was verified and what remains uncertain. An AI review does not prove live retailer behavior or replace passing CI and human review.
