---
description: Verify frontend code changes by inspecting the git diff, starting the app, and using a real browser through CDP. Use after making UI, routing, state, API integration, or client-side behavior changes.
---

# Verify Browser Change

Use this skill when code changes need browser-level confidence, especially for UI behavior, routes, forms, client state, visual regressions, auth-adjacent flows, or bug fixes that should be exercised in an actual page.

Primary browser verification mode is screenshot-path-first. After every `browser_observe`, use the returned `screenshotPath` as the visual artifact and avoid attaching screenshot image blocks to the main verification-agent context. Use DOM and accessibility metadata to identify actionable refs and confirm details, but make user-visible judgments from the screenshot by calling the separate vision analyzer when visual evidence matters.

Default orchestration is handled by the Claude Agent SDK agent tool `mcp__browser-change-agent__verify_change`. It reads the user's `~/.claude/settings.json` for model configuration, inspects the code diff, starts or uses the app, controls Chrome, and calls the vision analyzer when useful.

When a screenshot needs deeper visual judgment during manual debugging, call the separate vision MCP tool `mcp__browser-vision-analyzer__analyze_screenshot` with the `screenshotPath` returned by `browser_observe`. It performs the model call through Claude Agent SDK and uses the user's `~/.claude/settings.json` model configuration. Use it for visual regressions, layout comparisons, dense screenshots, subtle styling changes, or when the expected visual result is hard to judge from text metadata.

## Workflow

1. Inspect the code change first.
   - Use `git status --short --untracked-files=all`, `git diff --stat`, staged diff stat, targeted diffs, and relevant untracked files to identify changed routes, components, forms, data dependencies, feature flags, and expected user paths.
   - Infer the smallest meaningful browser scenario from the code, not from a prewritten test case or a generic homepage smoke test.
   - Before opening the browser, state a verification intent: changed files, inferred route/page, changed behavior, user action sequence, expected visible result, and nearest fallback if the route cannot be reached.
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
   - Prefer `browser_observe` with `includeScreenshotImage: false`; keep the screenshot file path in the main context instead of image bytes.
   - For layout, visible state, labels, errors, disabled/enabled controls, loading states, and visual regressions, call `mcp__browser-vision-analyzer__analyze_screenshot` with `screenshotPath` and a focused prompt.
   - Use `ariaNodes` from the same observation to pick stable refs after the visual target is understood.
   - Prefer `browser_click_ref` and `browser_type_ref` using refs from `ariaNodes`.
   - Use `browser_probe_dom` only when screenshot plus aria tree are not enough to identify the needed target.
   - Use coordinate clicks only as a last resort.

5. Validate the change.
   - Exercise the user flow affected by the diff.
   - Check both positive evidence and likely regression points nearby using screenshot paths and focused vision-analysis calls when visual judgment is required.
   - For visual changes or ambiguous screenshots, send `screenshotPath` to `mcp__browser-vision-analyzer__analyze_screenshot` with a focused prompt.
   - Watch `consoleErrors` and `failedRequests` from observations.
   - Treat screenshots as the primary evidence for user-visible behavior; use DOM/JS inspection as supporting evidence for hidden state or hard-to-see details.

6. Report the result.
   - Say what changed area was verified.
   - List the exact route or URL, actions performed, and observed outcome.
   - Mention any console errors, failed requests, blockers, assumptions, and vision-model analysis when used.
   - Close the browser with `browser_close` when done unless the user asks to keep it open.

## Heuristics

- For route/page file changes, verify the route or layout segment implied by the file path and route conventions.
- For component-only changes, find the route, story, or page that renders the component.
- For form changes, verify typing, validation, submission state, and success/error messaging.
- For navigation changes, verify deep links and back/forward-adjacent behavior when relevant.
- For data fetching changes, verify loading, success, empty, and error-adjacent UI if they are practical to reach.
- For styling changes, capture a screenshot path and explicitly mention what visual state was checked.
- For any visual or interaction verification, describe what was seen in the screenshot before describing DOM details.

## Change-to-scenario inference

Build the verification scenario from the diff before browser work:

- Changed files: list the frontend-relevant files and whether they are modified, staged, renamed, or untracked.
- Route/page inference: map route files, router config, links, imports, stories, or parent pages to the URL or preview surface that renders the changed code.
- Behavior under test: name the specific changed behavior, state, validation, copy, navigation, data loading, or visual condition.
- User flow: choose the shortest realistic actions that expose the changed behavior.
- Evidence plan: name what screenshot-visible result, console state, failed request state, or form/navigation outcome would prove the change.
- Fallback: if the exact route cannot be inferred or reached, use the closest page/story that renders the component and report the assumption.

Do not verify only the app shell, landing page, or homepage unless the diff points there or no narrower changed surface can be found.

## Context-efficient visual analysis

Keep image bytes out of the main verification-agent context unless the user is manually debugging a single screenshot:

- Call `browser_observe` with `includeScreenshotImage: false` by default.
- Keep `screenshotPath`, visible text, aria nodes, console errors, and failed requests in the main context.
- Send screenshots to `mcp__browser-vision-analyzer__analyze_screenshot` only for focused visual questions.
- Ask the vision analyzer narrow questions tied to the verification intent, such as whether a specific error message, disabled state, layout, or changed copy is visible.
- Ask the vision analyzer to return compact evidence: pass/fail/blocked, visible evidence, concerns, and confidence.
- Do not re-analyze the same screenshot unless a new question is necessary.
- Report the screenshot path and compact vision summary instead of carrying screenshot image data forward.

Do not ask the user for a manual test script unless the changed behavior cannot be inferred from code and local context.
