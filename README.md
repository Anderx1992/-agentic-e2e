# Browser Change Verifier

Claude Code plugin for verifying frontend code changes in a real Chrome browser.

The plugin changes the old runner model: it no longer executes natural-language YAML test cases. Claude Code gets a browser-verification skill, CDP browser MCP tools, and a Claude Agent SDK orchestration tool that can inspect code changes, start the app, operate Chrome, and ask the vision MCP for screenshot analysis.

## What It Adds

- A Claude Code plugin manifest at `.claude-plugin/plugin.json`
- A skill at `skills/verify-browser-change/SKILL.md`
- A plugin Stop hook at `hooks/hooks.json` that can auto-run verification before Claude Code finishes a coding turn
- Three plugin MCP servers in `.mcp.json`
- A Claude Agent SDK verification agent that orchestrates diff inspection, app startup, browser control, and visual analysis
- CDP browser tools for navigation, screenshot-first observation, element refs, typing, key presses, DOM probes, JavaScript inspection, console errors, and failed network requests
- A separate vision-analysis MCP tool that reads a screenshot and calls Claude Agent SDK

## Local Development

Install dependencies:

```bash
npm install
```

Run checks:

```bash
npm run typecheck
npm test
```

Build the plugin runtime bundles:

```bash
npm run build
```

For a release-ready plugin directory, run:

```bash
npm run prepare:plugin
```

Run the MCP server directly for debugging:

```bash
npm run mcp
npm run mcp:vision
npm run mcp:agent
```

## Use In Claude Code

There are two practical ways to use this plugin with Claude Code.

### Option 1: Load Directly While Developing

From this repository, start Claude Code with the plugin directory:

```bash
claude --plugin-dir .
```

Claude Code will load:

- the plugin manifest from `.claude-plugin/plugin.json`
- the bundled Agent SDK, browser, and vision MCP servers from `.mcp.json`
- the verification skill from `skills/verify-browser-change/SKILL.md`

Inside Claude Code, verify that the plugin is available:

```text
/plugin
/mcp
/help
```

You should see the `browser-change-verifier` plugin, the `browser-change-agent`, `browser-change-verifier`, and `browser-vision-analyzer` MCP servers, and the namespaced skill.

### Option 2: Install As A Local Plugin

During development, `--plugin-dir .` is the simplest option because it avoids a marketplace install cycle.

For team distribution, publish this directory through a Claude Code plugin marketplace, then install it with:

```bash
claude plugin install browser-change-verifier@your-marketplace --scope project
```

Use `--scope project` when the whole team should get the plugin through `.claude/settings.json`; use `--scope user` for personal installation.

The distributed plugin must include:

- `.claude-plugin/plugin.json`
- `.mcp.json`
- `hooks/hooks.json`
- `skills/verify-browser-change/SKILL.md`
- `dist/`
- `README.md`

It does not need `node_modules`, and plugin users do not need to run `npm install`.

## Daily Usage

When the plugin is enabled, Claude Code gets an agent-triggered self-verification path. A lightweight `PostToolUse` hook marks the turn whenever the agent writes code with `Write`, `Edit`, or `MultiEdit`. On the later `Stop` hook, `browser-change-agent.auto_verify_stop` checks the current git state. If the marked turn left frontend-relevant files changed and that exact diff fingerprint has not already been verified, it runs the browser verification agent and feeds the result back to Claude before the turn finishes.

The auto hook:

1. Marks agent edit turns through `browser-change-agent.mark_agent_edit`.
2. Reads `git status --short --untracked-files=all`, `git diff --stat`, staged diff stat, targeted diffs, and relevant untracked frontend file contents for fingerprinting.
3. Skips when the current turn did not write code, when there are no frontend-relevant changes, or when the same diff fingerprint was already verified.
4. Stores the last verified diff fingerprint in Claude plugin data, so the same diff is not verified repeatedly.
5. Runs screenshot-first browser verification and returns the result as Stop-hook context.
6. Lets Claude continue: if verification passed it should report evidence and finish; if verification failed or was blocked it should fix and let the hook re-run on the new diff.

Set `BROWSER_CHANGE_VERIFIER_AUTO_VERIFY=0` to disable the automatic Stop-hook verifier for a session.
Set `BROWSER_CHANGE_VERIFIER_VERIFY_EXISTING_DIFF=1` to verify an existing frontend diff even when the current turn was not marked by an agent edit hook.

You can still ask Claude Code to verify manually after you make or review frontend changes:

```text
Use browser-change-verifier to verify the current frontend diff in a real browser.
```

Or invoke the skill explicitly:

```text
/browser-change-verifier:verify-browser-change
```

Claude Code should then:

1. Inspect `git status --short --untracked-files=all`, `git diff --stat`, staged diff stat, and targeted diffs.
2. Infer the affected route, component, form, or UI flow.
3. Call `mcp__browser-change-agent__verify_change`.
4. Let the Agent SDK verification agent start/use the app, control Chrome, observe screenshots, and call the vision analyzer when useful.
5. Report the route, actions, result, screenshot path, model visual analysis when used, console errors, and failed requests.

Example prompt after changing a component:

```text
I changed the customer creation form. Please use browser-change-verifier to inspect the diff, start the app, open the affected route, fill the form, and confirm the new validation behavior works without console errors.
```

Example prompt after fixing a route bug:

```text
Please verify this routing fix in Chrome. Infer the route from the diff, start the app, navigate there, check the visible behavior, and report any failed requests or console errors.
```

Example prompt after visual styling work:

```text
Use browser-change-verifier to check the visual state touched by this CSS change. Capture a screenshot and tell me what you verified.
```

Example prompt that makes the screenshot-first preference explicit:

```text
Use browser-change-verifier to verify this change. Prioritize screenshot-based visual analysis first, then use aria/DOM refs only to interact with the page and confirm details.
```

## Screenshot-First Verification

`browser_observe` returns a screenshot image in the MCP result by default, in addition to `screenshotPath`, `ariaTree`, `ariaNodes`, visible text, console errors, and failed requests.

Preferred order when operating the browser:

1. Call `browser_observe`.
2. Analyze the screenshot visually: layout, visible labels, button state, form validation, loading state, spacing, contrast, and whether the changed UI is actually present.
3. Use `ariaNodes` refs to click/type once the visual target is clear.
4. If the screenshot needs stronger visual judgment, call `mcp__browser-vision-analyzer__analyze_screenshot` with `screenshotPath` and a focused prompt.
5. Use `browser_probe_dom` or `browser_run_js` only for details that are hidden, ambiguous, or not visually inspectable.
6. Report what was seen in the screenshot before reporting DOM-level evidence.

## Vision MCP

The second MCP server, `browser-vision-analyzer`, encapsulates "read screenshot, call Claude Agent SDK, return analysis". It does not call Anthropic, OpenAI, or OpenAI-compatible HTTP APIs directly.

Tool:

- `mcp__browser-vision-analyzer__analyze_screenshot`

Inputs:

- `screenshotPath`: path returned by `browser_observe`
- `imageBase64`: optional alternative to `screenshotPath`
- `prompt`: visual verification question
- `model`: optional Claude Agent SDK model override
- `maxTurns`: optional SDK turn limit, default `1`
- `timeoutMs`: optional SDK timeout, default `120000`

Model configuration is shared with the high-level agent. The MCP reads `~/.claude/settings.json`, passes that settings file to Claude Agent SDK, and falls back to `CLAUDE_MODEL` or the SDK default if no user setting exists.

Typical flow:

```text
mcp__browser-change-verifier__browser_observe
mcp__browser-vision-analyzer__analyze_screenshot({ screenshotPath, prompt })
```

Keep browser control and vision judgment separate: use `browser-change-verifier` to navigate and capture, then `browser-vision-analyzer` for Claude Agent SDK-based screenshot analysis.

## What Claude Code Actually Calls

The skill is instructional; the default entrypoint is the Agent SDK MCP tool:

```text
mcp__browser-change-agent__verify_change
```

The agent then uses lower-level browser and vision MCP tools internally. A typical internal sequence looks like:

```text
mcp__browser-change-verifier__browser_start
mcp__browser-change-verifier__browser_navigate
mcp__browser-change-verifier__browser_observe
mcp__browser-change-verifier__browser_click_ref
mcp__browser-change-verifier__browser_type_ref
mcp__browser-change-verifier__browser_observe
mcp__browser-vision-analyzer__analyze_screenshot
mcp__browser-change-verifier__browser_close
```

You normally do not need to call the lower-level tools manually. Ask Claude Code to verify the change, and the skill tells it to invoke the Agent SDK tool.

## Agent SDK Model Configuration

`browser-change-agent` uses Claude Agent SDK as the agent framework. Before each `verify_change` run, it reads:

```text
~/.claude/settings.json
```

It extracts model information such as:

- `model`
- `fallbackModel`
- `effort`

The same settings path is also passed into the Agent SDK `query()` call so Claude Code settings are applied by the SDK. If the file does not exist, the agent falls back to `CLAUDE_MODEL` and then to the SDK default model.

For the Claude Code executable used by Claude Agent SDK, the plugin prefers a local installation:

1. `CLAUDE_CODE_PATH` or `CLAUDE_PATH` when set
2. `claude` found on `PATH` or Windows `Path`
3. npm global install locations on Windows, including `NPM_CONFIG_PREFIX`, `npm_config_prefix`, `%APPDATA%\npm`, and `%USERPROFILE%\AppData\Roaming\npm`
4. Common local install locations such as `/opt/homebrew/bin` or `/usr/local/bin` on macOS
5. Claude Agent SDK default executable resolution

Example user settings:

```json
{
  "model": "claude-sonnet-4-5",
  "fallbackModel": ["claude-sonnet-4-5", "claude-haiku-4-5"],
  "effort": "high"
}
```

You can call the agent directly:

```text
mcp__browser-change-agent__verify_change({
  "instruction": "Verify the current frontend diff with screenshot-first visual analysis.",
  "appUrl": "http://localhost:3000",
  "startCommand": "npm run dev",
  "headless": true
})
```

## Local Smoke Test

You can verify that the MCP server starts and exposes tools without launching Claude Code:

```bash
npm run mcp
```

For full plugin testing, run Claude Code:

```bash
claude --plugin-dir .
```

Then inside Claude Code:

```text
/mcp
Use browser-change-verifier to open a simple local page and observe it.
```

## Troubleshooting

If the plugin does not appear:

- Make sure Claude Code is started from this repository with `claude --plugin-dir .`.
- Run `/reload-plugins` inside Claude Code after editing plugin files.
- Run `/plugin` and `/mcp` to check plugin and MCP server status.
- Check that Node.js is available on PATH.

If browser tools do not appear:

- Confirm `npm run build` has generated `dist/mcp/*.mjs`.
- Run `npm install` in this repository only for source development.
- Run `npm run mcp`, `npm run mcp:vision`, or `npm run mcp:agent` to see startup errors directly.

If the Agent SDK verification tool fails:

- Confirm `~/.claude/settings.json` exists if you expect a specific model.
- Confirm Claude Code authentication or `ANTHROPIC_API_KEY` is configured for the Agent SDK.
- Pass `appUrl` and `startCommand` explicitly if inference from the repository is ambiguous.

If vision analysis fails:

- Confirm Claude Code authentication or `ANTHROPIC_API_KEY` is configured for Claude Agent SDK.
- Confirm `~/.claude/settings.json` contains the model you expect, or pass `model` explicitly to `analyze_screenshot`.
- Confirm that `screenshotPath` exists and points to a PNG/JPEG/GIF/WebP file.

If Chrome does not start:

- Install Chrome, Chromium, or Edge.
- Set `CHROME_PATH` to the browser executable if auto-detection fails.
- If you already have Chrome running with remote debugging, call `browser_start` with an existing `cdpUrl`.

## MCP Tools

The high-level agent MCP exposes:

- `mcp__browser-change-agent__verify_change`

The plugin exposes these tools under `browser-change-verifier`:

- `browser_start`
- `browser_navigate`
- `browser_observe`
- `browser_click_ref`
- `browser_click_xy`
- `browser_type_ref`
- `browser_type_text`
- `browser_press_key`
- `browser_scroll`
- `browser_wait`
- `browser_run_js`
- `browser_probe_dom`
- `browser_close`

Use `browser_observe` before visible actions. It returns a screenshot image plus `ariaNodes` with refs such as `e1`; visually analyze the screenshot first, then prefer ref-based tools over coordinate clicks. Use `browser_probe_dom` when screenshot plus accessibility metadata are not enough.

## Runtime Notes

When installed as a plugin, `.mcp.json` starts prebuilt Rolldown bundles in `dist/mcp/*.mjs`. Runtime startup does not install third-party Node dependencies and does not require `tsx`.

`scripts/start-mcp.mjs` is a development-only fallback for source runs. It expects local dev dependencies to already exist and never runs `npm install`.

The browser layer uses `chrome-remote-interface`, which is a direct Chrome DevTools Protocol client. It does not depend on Playwright, Puppeteer, or a browser test runner.

## References

- Claude Code plugin structure: https://code.claude.com/docs/en/plugins
- Claude Code plugin reference: https://code.claude.com/docs/en/plugins-reference
- Plugin-provided MCP servers: https://code.claude.com/docs/en/mcp
