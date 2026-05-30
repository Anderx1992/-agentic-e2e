# Agentic E2E

Natural-language browser automation testing:

- The test case is written in natural language.
- Claude Agent SDK decides whether the case passed and what to do next.
- The built-in TypeScript CDP harness performs browser actions through the same Chrome session.
- Playwright connects to the same CDP browser for screenshots, text extraction, console logs, and network failures.

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
        +--> Playwright observer
        |
        v
JSON + HTML report
```

Playwright is intentionally not used for assertions here. It is the test infrastructure layer: browser lifecycle, screenshots, visible text, console messages, failed requests, and artifacts.

The Claude Agent SDK owns the agent loop. This project exposes browser actions as in-process MCP tools:

- `observe_browser`
- `click`
- `type_text`
- `press_key`
- `scroll`
- `wait`
- `navigate`
- `run_js`
- `finish_test`
