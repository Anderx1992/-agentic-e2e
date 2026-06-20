# Browser Change Verifier

Claude Code plugin for verifying frontend code changes in a real Chrome browser.

The plugin changes the old runner model: it no longer executes natural-language YAML test cases or runs its own Claude Agent SDK loop. Claude Code stays in charge of reading diffs, editing code, starting the app, and deciding what to verify. This plugin contributes a focused browser-verification skill plus MCP tools that operate Chrome through CDP.

## What It Adds

- A Claude Code plugin manifest at `.claude-plugin/plugin.json`
- A skill at `skills/verify-browser-change/SKILL.md`
- Three plugin MCP servers in `.mcp.json`
- A Claude Agent SDK verification agent that orchestrates diff inspection, app startup, browser control, and visual analysis
- CDP browser tools for navigation, screenshot-first observation, element refs, typing, key presses, DOM probes, JavaScript inspection, console errors, and failed network requests
- A separate vision-analysis MCP tool that reads a screenshot and calls a configured multimodal model

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
- the Agent SDK, browser, and vision MCP servers from `.mcp.json`
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

## Daily Usage

After you make or review frontend changes, ask Claude Code to verify them:

```text
Use browser-change-verifier to verify the current frontend diff in a real browser.
```

Or invoke the skill explicitly:

```text
/browser-change-verifier:verify-browser-change
```

Claude Code should then:

1. Inspect `git diff --stat` and targeted diffs.
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

The second MCP server, `browser-vision-analyzer`, encapsulates "read screenshot, call multimodal model, return analysis".

Tool:

- `mcp__browser-vision-analyzer__analyze_screenshot`

Inputs:

- `screenshotPath`: path returned by `browser_observe`
- `imageBase64`: optional alternative to `screenshotPath`
- `prompt`: visual verification question
- `provider`: `auto`, `anthropic`, `openai`, or `openai-compatible`
- `model`: optional model override

Provider configuration:

```bash
# Anthropic
ANTHROPIC_API_KEY=...
VISION_MODEL=claude-sonnet-4-5

# OpenAI
OPENAI_API_KEY=...
VISION_MODEL=gpt-4o

# OpenAI-compatible endpoint
VISION_API_URL=https://your-provider.example/v1
VISION_API_KEY=...
VISION_MODEL=your-vision-model
```

Typical flow:

```text
mcp__browser-change-verifier__browser_observe
mcp__browser-vision-analyzer__analyze_screenshot({ screenshotPath, prompt })
```

Keep browser control and vision judgment separate: use `browser-change-verifier` to navigate and capture, then `browser-vision-analyzer` for model-based screenshot analysis.

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
- Check that Node.js and npm are available on PATH.

If browser tools do not appear:

- The MCP servers may still be starting or installing dependencies into `${CLAUDE_PLUGIN_DATA}`.
- Run `npm install` in this repository for development use.
- Run `npm run mcp`, `npm run mcp:vision`, or `npm run mcp:agent` to see startup errors directly.

If the Agent SDK verification tool fails:

- Confirm `~/.claude/settings.json` exists if you expect a specific model.
- Confirm Claude Code authentication or `ANTHROPIC_API_KEY` is configured for the Agent SDK.
- Pass `appUrl` and `startCommand` explicitly if inference from the repository is ambiguous.

If vision analysis fails:

- Set one provider credential: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `VISION_API_URL` plus `VISION_API_KEY`.
- Set `VISION_MODEL` if your provider does not support the default model name.
- Confirm that `screenshotPath` exists and points to a PNG/JPEG/WebP file.

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

When installed as a plugin, `scripts/start-mcp.mjs` installs Node dependencies into `${CLAUDE_PLUGIN_DATA}` and runs the TypeScript MCP server from the plugin root. This keeps generated dependency files out of the plugin installation directory and survives plugin updates.

The browser layer uses `chrome-remote-interface`, which is a direct Chrome DevTools Protocol client. It does not depend on Playwright, Puppeteer, or a browser test runner.

## References

- Claude Code plugin structure: https://code.claude.com/docs/en/plugins
- Claude Code plugin reference: https://code.claude.com/docs/en/plugins-reference
- Plugin-provided MCP servers: https://code.claude.com/docs/en/mcp
