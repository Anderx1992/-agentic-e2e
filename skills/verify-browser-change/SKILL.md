---
description: Verify frontend code changes by inspecting the git diff, starting the app, and using a real browser through CDP. Use after making UI, routing, state, API integration, or client-side behavior changes.
---

# Verify Browser Change

Use this skill when code changes need browser-level confidence, especially for UI behavior, routes, forms, client state, visual regressions, auth-adjacent flows, or bug fixes that should be exercised in an actual page.

Primary browser verification mode is screenshot-first. After every `browser_observe`, inspect the screenshot visually before relying on `ariaNodes`, visible text, or DOM probes. Use DOM and accessibility metadata to identify actionable refs and confirm details, but make the first judgment from what the user would actually see.

Default orchestration is handled by the Claude Agent SDK agent tool `mcp__browser-change-agent__verify_change`. It reads the user's `~/.claude/settings.json` for model configuration, inspects the code diff, starts or uses the app, controls Chrome, and calls the vision analyzer when useful.

When a screenshot needs deeper visual judgment during manual debugging, call the separate vision MCP tool `mcp__browser-vision-analyzer__analyze_screenshot` with the `screenshotPath` returned by `browser_observe`. Use it for visual regressions, layout comparisons, dense screenshots, subtle styling changes, or when the expected visual result is hard to judge from text metadata.

## Workflow

1. Inspect the code change first.
   - Use `git diff --stat` and targeted `git diff` reads to identify changed routes, components, forms, data dependencies, feature flags, and expected user paths.
   - Infer the smallest meaningful browser scenario from the code, not from a prewritten test case.
   - If the app start command is not obvious, inspect `package.json`, framework config, and README files.

2. Prefer the SDK agent for end-to-end orchestration.
   - Call `mcp__browser-change-agent__verify_change` with a concise instruction, known `appUrl`, or `startCommand` when available.
   - Let the agent read `~/.claude/settings.json` for model and fallback model selection.
   - Use lower-level browser and vision MCP tools directly only when debugging the agent or taking manual control.

3. Start the app with normal Claude Code shell tools when manually verifying.
   - Prefer the project's existing dev or preview command.
   - Keep the server running while verifying.
   - Note the local URL and any required setup or seed data.

4. Start or connect the browser MCP tools when manually verifying.
   - Use `mcp__browser-change-verifier__browser_start` first.
   - Navigate with `browser_navigate`.
   - Observe before every visible action with `browser_observe`.
   - Analyze the returned screenshot image first: layout, visible state, labels, errors, disabled/enabled controls, loading states, and visual regressions.
   - Use `ariaNodes` from the same observation to pick stable refs after the visual target is understood.
   - Prefer `browser_click_ref` and `browser_type_ref` using refs from `ariaNodes`.
   - Use `browser_probe_dom` only when screenshot plus aria tree are not enough to identify the needed target.
   - Use coordinate clicks only as a last resort.

5. Validate the change.
   - Exercise the user flow affected by the diff.
   - Check both positive evidence and likely regression points nearby using screenshot observations first.
   - For visual changes or ambiguous screenshots, send `screenshotPath` to `mcp__browser-vision-analyzer__analyze_screenshot` with a focused prompt.
   - Watch `consoleErrors` and `failedRequests` from observations.
   - Treat screenshots as the primary evidence for user-visible behavior; use DOM/JS inspection as supporting evidence for hidden state or hard-to-see details.

6. Report the result.
   - Say what changed area was verified.
   - List the exact route or URL, actions performed, and observed outcome.
   - Mention any console errors, failed requests, blockers, assumptions, and vision-model analysis when used.
   - Close the browser with `browser_close` when done unless the user asks to keep it open.

## Heuristics

- For component-only changes, find the route, story, or page that renders the component.
- For form changes, verify typing, validation, submission state, and success/error messaging.
- For navigation changes, verify deep links and back/forward-adjacent behavior when relevant.
- For data fetching changes, verify loading, success, empty, and error-adjacent UI if they are practical to reach.
- For styling changes, capture a screenshot path and explicitly mention what visual state was checked.
- For any visual or interaction verification, describe what was seen in the screenshot before describing DOM details.

Do not ask the user for a manual test script unless the changed behavior cannot be inferred from code and local context.
