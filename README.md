# Agentic E2E

Natural-language browser automation testing:

- The test case is written in natural language.
- Claude Agent SDK decides whether the case passed and what to do next.
- The built-in TypeScript CDP harness performs browser actions through the same Chrome session.
- Playwright connects to the same CDP browser for aria/DOM observation, screenshots, text extraction, console logs, and network failures.

## Prerequisites

1. Node.js 20+
2. Chrome or Chromium
3. `ANTHROPIC_API_KEY` for Claude Agent SDK

## Install

```bash
npm install
```

## Configure

Copy `.env.example` to `.env` or export the variables in your shell.

```bash
ANTHROPIC_API_KEY=...
CLAUDE_MODEL=sonnet
```

## Run One Case

```bash
npm run case -- cases/customer-create.yaml
```

## Run A Suite

```bash
npm run suite -- cases
```

## Architecture

```text
YAML natural-language case
        |
        v
Agent loop
        |
        +--> Claude Agent SDK
        |
        +--> TypeScript CDP action executor
        |
        +--> Playwright observer + CDP aria tree
        +--> Markdown agent-skills memory
        |
        v
JSON + HTML report
```

Playwright is intentionally not used for assertions here. It is the test infrastructure layer: browser lifecycle, aria tree extraction, screenshots, visible text, console messages, failed requests, and artifacts.

The observer supplements screenshots with a CDP accessibility tree. `observe_browser` returns `ariaTree` and `ariaNodes`; each usable node has a short `ref` such as `e3`. The agent should prefer `click_element` and `type_into_element` with those refs.

Some business pages do not expose useful aria metadata. In that case the agent can generate a small `probe_dom` JavaScript script to inspect the real DOM directly by selector, text, attributes, layout, or application-specific markup. The script can call `ref(element, metadata)` to register DOM nodes as actionable refs, then continue with `click_element` or `type_into_element`. Screenshot coordinates are the last fallback.

## Agent Skills

The runner keeps a local self-improving memory in `agent-skills/*.md`.

When a passing case contains an action that took more than two tool calls to figure out, the runner writes a Markdown skill with YAML front matter. The Markdown body is readable and editable; the front matter stores validation metadata such as URL scope, selector, text hint, confidence, expiry, and evidence.

Skills are treated as fallible hints. Before each case, the runner opens the start URL and validates candidate skills against the current DOM. Expired or mismatching skills are marked `stale`, repeated validation failures retire them, and they are not injected into the agent prompt. A later successful run can refresh or replace stale knowledge with the current DOM path.

Skill loading is progressive. The initial prompt only includes a compact validated skill index: id, title, scope, confidence, target hint, and validation status. Full guidance, selectors, and historical probe scripts stay out of the prompt until the agent explicitly calls `read_agent_skill` for one relevant skill id.

The Claude Agent SDK owns the agent loop. This project exposes browser actions as in-process MCP tools:

- `observe_browser`
- `click`
- `click_element`
- `type_text`
- `type_into_element`
- `press_key`
- `scroll`
- `wait`
- `navigate`
- `run_js`
- `probe_dom`
- `finish_test`
