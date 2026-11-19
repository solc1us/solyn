# Frontend styling refactor — R0 audit and proposed plan

**Status:** R0 complete; R1–R4 NOT started; PM review required.

**Branch:** `refactor/web-tailwind-styling`

**Audited/base commit:** `e5393e5a408b372a5845beecd632164691e77403`

**Design authority:** `docs/DESIGN.md` **2.0**, unchanged. Preserve the approved appearance and behavior, not just its general direction.

## 1. Phase 2 integration record

PM confirmed Data API was disabled, saved and still disabled after refresh, and that no production deployment/CI/CD integration exists. Repository inspection found no tracked deployment automation. These confirmations authorize this merge; they are not a new agent inspection of Supabase settings.

After fetching, both local/remote `main` were `4bb21a1fe7c5f20bbf22cbdbae867c21556bb285`; both Phase 2 refs were the expected audited head. The working tree was clean. All seven Phase 2 commits were present, including visual refinement, hardening and secure auth logging. Ancestry checks passed.

Final checks before merging:

- `bun test`: **165 passed, 0 failed**, 10 files.
- `bun run check-types`: all four checked workspaces exited 0.
- `bunx oxlint`: exit 0.
- `bun run --filter web build`: exit 0; `/chat` and `/api/chat/stream` included.
- `bunx oxfmt --check` over 28 supported, nongenerated Phase 2 source/documentation files: pass. Generated migration snapshot/SQL, environment schema and lockfile were not reformatted.
- `git diff --check main...feat/phase-2-ai-chat` and working-tree check: pass.

Executed `git merge --ff-only feat/phase-2-ai-chat` on `main`, pushed `main`, fetched and verified matching hashes. Created the refactor branch from updated main and pushed it with upstream tracking. `main`, `origin/main`, Phase 2 and the new local/remote branch all pointed at `e5393e5a408b372a5845beecd632164691e77403`. No branch deletion, history rewrite, migration or deployment occurred. This audit document is an uncommitted R0 deliverable, not a new implementation commit.

## 2. Current styling architecture

### Entry points and cascade

1. `apps/web/src/app/layout.tsx` imports `apps/web/src/index.css`, installs Geist/Geist Mono variables and renders `.dark`; `components/providers.tsx` forces dark theme and mounts Sonner.
2. `index.css` imports `@solyn/ui/globals.css`. The shared stylesheet imports Tailwind 4, `tw-animate-css` and `shadcn/tailwind.css`; defines scaffold light/dark tokens, Tailwind aliases, a dark variant and base-layer defaults.
3. Web CSS overrides theme variables and font aliases and supplies most actual Solyn geometry and component styles. It is **unlayered**, so its normal declarations outrank normal Tailwind utility-layer declarations. A utility class added to JSX is not sufficient while the old owning rule still applies.
4. `packages/ui/components.json` specifies **base-lyra**, CSS variables and Base UI-backed shadcn-style components. There is no Tailwind JS configuration to replace. `apps/web/postcss.config.mjs` and `packages/ui/postcss.config.mjs` already use the existing Tailwind PostCSS integration.
5. `packages/ui/src/lib/utils.ts` reexports installed `cn@0.5.2`: conditional joining plus Tailwind conflict resolution, not plain string concatenation. Use it; do not install another merger or introduce a build plugin.

### Scope inventory

`index.css` has 1,211 source lines and 96 distinct class names in selector preludes (a source inventory, not runtime coverage). Every class has a source consumer or a known generated consumer. The lack of a literal `chat-message-user` in TSX is expected: `chat-screen.tsx` emits `chat-message-${message.role}`. `bg-primary`/`bg-secondary` originate in Button variants; they are not dead selectors.

Only five of the 17 shared component modules have direct application imports:

| Primitive      | Actual consumers / customization                                                                                                                                                                                                                                                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button.tsx`   | Eight modules: shell, sign-out, chat screen, collection, note editor, project form, retry panel, login. All currently use the default size; live variants are default, secondary and ghost. CVA also exports outline/destructive/link and additional sizes; do not remove them as unused API. `.control` overrides geometry, and default/secondary surfaces depend on generated `bg-*` classes. |
| `input.tsx`    | Project form, Note Editor, login. Base UI Input; shared tiny/square/ring/dark utilities are overridden by `.form-control` and editor field classes.                                                                                                                                                                                                                                             |
| `textarea.tsx` | Project description, note content/comparison, chat composer. Plain textarea with `cn`; default content field sizing/resize/focus utilities have context-specific overrides.                                                                                                                                                                                                                     |
| `label.tsx`    | Project form, Note Editor, login. Shared text-xs/leading-none is combined with `.field [data-slot="label"]` color and 14px size. Preserve its actual line height.                                                                                                                                                                                                                               |
| `sonner.tsx`   | Mounted by `components/providers.tsx`; retains its inline CSS-variable bridge and third-party integration. No current app toast invocation was found. Mounted infrastructure is not dead code.                                                                                                                                                                                                  |

The other 12 modules have no current app import: `attachment.tsx`, `bubble.tsx`, `card.tsx`, `checkbox.tsx`, `dropdown-menu.tsx`, `empty.tsx`, `input-group.tsx`, `marker.tsx`, `message.tsx`, `message-scroller.tsx`, `skeleton.tsx` and `tooltip.tsx`. Retain them. Their existing utility/variant structure was inspected; they are not migration targets. In particular, do not substitute Bubble/Message/MessageScroller/InputGroup into chat: their structure, default widths, typography, focus and scroll behavior differ from approved Solyn.

### Selector-to-consumer map

Paths below are relative to `apps/web/src/` unless explicitly prefixed `packages/ui/`. Descendant/pseudo/state selectors belong to the same row as their root class. Global element selectors are covered separately.

| CSS families / selectors                                                                                                                                                                                                                      | Actual owner(s)                                                                                                                                          | Recommended destination                                                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `:root`, `.dark`, `@theme`, `html`, `body`, `body::before`, `::selection`, `:focus-visible`, element tap/cursor rules, `h1/h2/h3/p`, `fieldset`                                                                                               | Root layout; all routes; shared primitives                                                                                                               | Keep true globals, tokens, sky/star pseudo-element and accessibility policies in CSS. Move route-specific typography into its owner rather than changing global headings during R1.                  |
| `.control[data-slot="button"]`, `.primary-link`, `.secondary-link` including `:is(.bg-primary,.bg-secondary)` / hover / active / disabled; `.text-link`, `.inline-actions`                                                                    | All eight Button consumers; projects screen/detail, collection empty state, error/not-found views, forms and chat                                        | Reuse existing Button CVA for neutral controls/action links; move simple grouping/link layout to owners. Preserve ghost behavior separately.                                                         |
| `.workspace-shell`, `.skip-link`, `.sidebar`, `.sidebar-brand`, `.sidebar-caption`, `.sidebar nav`, `.nav-item`, `.sidebar-bottom`, `.account`, `.avatar`, `.mobile-header`, `.is-open`, `.workspace-main`, `.is-chat`, `.wordmark`, `.glass` | `components/workspace-shell.tsx`; `.wordmark` also login; `.sign-out` in `components/sign-out-button.tsx`                                                | Utility-first shell geometry and state styling; keep glass support fallback and sensitive scroll/focus relationships explicit. Retain the `is-open` hook used by chat JS.                            |
| `.recent-conversations` and descendants                                                                                                                                                                                                       | `components/workspace-shell.tsx`                                                                                                                         | R2 sidebar utilities, including its 42px desktop / 44px mobile rows. Not part of the streaming engine.                                                                                               |
| `.page-content`, `.page-heading` and descendants                                                                                                                                                                                              | `features/workspace/projects-screen.tsx`; workspace project/note new/detail/edit and loading/error/not-found route files                                 | Migrate as one page-grid/header family. Preserve negative desktop header margins, sticky top clearance, mobile normal flow and the 1100px wrapping rule.                                             |
| `.project-summary`, `.project-description`, qualified `.metadata`, `.section-heading`                                                                                                                                                         | `app/(workspace)/projects/[projectId]/page.tsx`                                                                                                          | Owner utilities; description remains scrolling content outside sticky header. Preserve current description color/line-height cascade.                                                                |
| `.collection`, `.collection-list`, `.collection-row`, `.item-icon`, `.item-copy`, `.item-title`, `.row-chevron`, `.collection-footer`, `.collection-feedback`, `.empty-state`                                                                 | `features/workspace/collection.tsx`, reused for both project and note lists                                                                              | Direct utilities for grid, hover, truncation, time placement, footer and empty/error states; keep content-visibility/intrinsic-size and inward row focus clearance.                                  |
| `.breadcrumbs` and descendants                                                                                                                                                                                                                | `features/workspace/feedback.tsx`, used by project/note routes                                                                                           | Local utilities; do not change escaped text, links or aria-current.                                                                                                                                  |
| `.project-form`, `.form-fields`, `.field`, `.required-hint`, `.form-control`, `.description-input`, `.field-help`, `.field-error`, `.form-footer`                                                                                             | `features/workspace/project-form.tsx`; labels/help/error styles also Note Editor/login; form controls also chat-adjacent shared primitives               | Shared control appearance in R1, owner layout in R2. Project form fills canvas width; no return to a centered 680px column.                                                                          |
| `.feedback`, `.feedback-error` and child link rules                                                                                                                                                                                           | `features/workspace/feedback.tsx`, login inline error, chat inline error                                                                                 | Migrate callers atomically before deleting common rules; keep semantic alert roles and exact copy.                                                                                                   |
| `.note-editor`, `.editor-toolbar`, `.save-indicator`, `.editor-fields`, `.title-input`, `.date-field`, `.writing-area`, `.editor-metadata`, `.editor-feedback`, `.latest-version`, `.saved-comparison`                                        | `features/workspace/note-editor.tsx`; note create/detail route wrappers                                                                                  | Owner utilities; preserve 760px left-aligned reading column, borderless underline focus, date bounds, fixed note field sizing and comparison UI.                                                     |
| `.standalone-page`, `.status-panel`, `.loading-heading`, `.loading-surface`, `.surface`, workspace-qualified reset rules                                                                                                                      | `app/error.tsx`, `app/not-found.tsx`, workspace `error.tsx`, `not-found.tsx`, `loading.tsx`, `features/workspace/retry-panel.tsx`; `.surface` also login | Utilities on existing owners; explicitly preserve framed standalone vs unframed workspace states. Do not remove `.surface` wholesale while login still consumes it.                                  |
| `.login-page`, `.login-intro`, `.login-caption`, `.login-panel`, `.login-panel-heading`, `.login-form`, `.login-submit`, `.login-access`, `.wordmark`                                                                                         | `app/login/page.tsx`                                                                                                                                     | Simple layout is eligible for R2 class-only migration. R1 control changes must already be accepted here. Login handlers and auth client are excluded.                                                |
| `.chat-screen`, `.chat-header`, `.chat-header-row`, `.chat-scope`, `.chat-history` and descendants                                                                                                                                            | `features/chat/chat-screen.tsx` including its `ChatHistory` function                                                                                     | R3 JSX utilities, bounded history menu, scope link and header truncation/wrapping. No replacement menu library.                                                                                      |
| `.chat-messages`, `.chat-thread`, `.chat-empty`, `.chat-message`, `.chat-message-user`, message header/small/bubble descendants                                                                                                               | `features/chat/chat-screen.tsx`                                                                                                                          | R3 utilities, preserving desktop independent scroll, full-width thread, user-right fit-content/75%/760px and mobile 92%, assistant-left 760px. Use literal utility alternatives for role conditions. |
| `.chat-prose`, paragraph/headings/lists/code/pre/sibling selectors                                                                                                                                                                            | `features/chat/message-content.tsx`; user bubble background currently selected by parent role                                                            | Direct utilities where clear; retain a small scoped prose family if it keeps structural/code/sibling rules clearer than long arbitrary selectors. No typography/Markdown package.                    |
| `.chat-composer-area`, `.chat-composer-inner`, `.chat-notice`, `.chat-recovery`, `.chat-composer`, `.chat-input`, `.chat-composer-toolbar`, `.chat-help`                                                                                      | `features/chat/chat-screen.tsx`                                                                                                                          | R3 utilities; preserve `:empty` recovery collapse, outer focus-within border, inner borderless textarea, max-height, status layout, sticky mobile safe-area padding and exact help text.             |

## 3. Findings: duplication, conflicts and unused candidates

### Cascade and shared-control conflicts

- Scaffold token defaults versus Solyn overrides are intentional layering, not automatically duplicates to delete. `--sidebar` is both the existing app surface variable and a shared Tailwind color alias source. Keep that contract. Shared Inter font alias is overridden by web Geist; do not change font loading or add another font.
- Most Solyn-only variables (`--canvas`, `--button`, `--hover`, `--selected`, `--brand`) lack dedicated Tailwind color aliases. Add only aliases actually required by migrated utilities in the existing web `@theme inline`, with the exact existing values. Do not rename the full token system or prune unused chart/sidebar scaffold tokens speculatively.
- Shared Button has square/text-xs/ring/active-translation utilities; `.control` applies 7px/13px/32px geometry. Default/secondary action surfaces are selected via `.bg-primary`/`.bg-secondary`; this is a brittle cross-layer dependency. Remove it only in the same commit that takes over those variants and every affected link treatment. Do not accidentally change the currently different ghost active state.
- Shared Input/Textarea have focus/invalid rings and dark variants; app CSS suppresses shadows/outlines, supplies a single focus border and keeps invalid borders red. Their `md:text-xs` utilities are currently overridden by unlayered 16px field CSS. A migration that merely appends a base font utility can reintroduce 12px text at 768px. Resolve variant/responsive conflicts deliberately.
- The global focus outline is `!important`; normal `outline-none` utilities alone cannot implement field exceptions. Retain a small explicit global field-focus exception while it is needed. Do not globally remove link/button/region focus. Preserve invalid styling and Note Editor's bottom-border-only focus.
- `.primary-link` and `.secondary-link` currently have the same base/hover/active appearance. This is intentional neutral hierarchy. Reuse the existing CVA styling rather than inventing different colored variants or a new Link wrapper.
- Shared `cn` resolves known utility conflicts, but does not understand legacy semantic CSS rules. During migration, remove corresponding declarations atomically; do not leave two competing sources and rely on class order.

### Source scanning finding

`packages/ui/src/styles/globals.css` declares `@source "../../../apps/**/*.{ts,tsx}"`. Resolving from its stylesheet directory reaches **`packages/apps`**, which does not exist; reaching root `apps` requires one more parent segment. The shared `../**/*` source points correctly at `packages/ui/src`. The current web build passes, so automatic scanning currently provides the app's used utilities; there is no demonstrated missing-style defect. R1 should verify the installed Tailwind source-resolution behavior and correct only this existing app-source declaration if confirmed, then inspect generated representative classes. Do not add scanning plugins or narrow sources as speculative optimization. A public Tailwind documentation fetch was unavailable during R0; local path resolution is the evidence recorded here.

### Unused/redundant findings with source limits

- No entire class-selector family is proven unused. The source scan's only unmatched literal class is the dynamically emitted `chat-message-user`; retain it until its role styling is migrated.
- `.page-heading p` and `.page-heading .metadata` have no matching current header child in inspected routes/components. Project description/created metadata now live under `.project-summary`. Remove only these selector arms in R4 after reconfirming consumers; retain the live `.project-summary` arms.
- `narrow-page`, `editor-page`, `editor-wrap` and `content-field` are emitted class hooks with no current CSS definition or JS lookup found. They are not dead CSS rules. Optional R4 removal of class tokens is cosmetic; do not delete wrapper elements or invent missing styles. `chat-message-assistant` is also an emitted role hook without a dedicated rule; its base message styling is live.
- `.metadata` has qualified project/header rules, but no generic standalone rule. Chat's metadata-marked spans/paragraphs currently inherit their parent typography. Do not add a global metadata style while migrating.
- Mobile `.writing-area` repeats desktop `padding: 12px 0` and `min-height: 420px`, and mobile `.item-icon` repeats width/height. Those declarations are cleanup candidates, not evidence the responsive blocks are wholly redundant.
- Repeated `.workspace-main`, `.page-heading`, `.login-page`, `.chat-*` and `.glass` blocks implement breakpoint/support overrides. Do not deduplicate by selector name alone.

## 4. Layout, accessibility and browser-code contract

- **Breakpoints:** CSS mobile is `max-width: 760px`, desktop `min-width: 761px`; chat JS uses the same exact queries. Also preserve the 1100px header/login adjustments and independent coarse-pointer 44px minimum targets. Do not replace these with Tailwind's default md=768px or subtly different `<761px` behavior. Literal custom media variants or retained small CSS media blocks are acceptable; verify generated boundaries.
- **Desktop canvas:** fixed inset `16px 16px 16px 280px`; sidebar width 248px at left 16px; ordinary workspace scrolls inside the canvas, page heading is sticky. Chat switches the canvas to overflow-hidden and places the scroll region inside it. Preserve `min-height: 0`, stable gutters, keyboard region focus and scroll padding.
- **Mobile:** normal document flow, sticky mobile header/drawer, natural workspace scrolling, sticky chat composer and safe-area padding. No global body scroll lock or new nested mobile viewport.
- **Focus:** retain skip link, visible non-field keyboard outlines, inward collection-row offset, single-border fields, invalid feedback, document-field underline and composer outer focus-within. Buttons inside the composer retain their own focus indicators.
- **Content:** preserve exact widths, whitespace and truncation. Do not add global overflow-hidden to conceal long-text errors. Long code scrolls within its pre block, not the whole canvas. Preserve content-visibility and intrinsic sizing already used by collection items.
- **Motion/appearance:** keep reduced-motion policy, glass feature-query fallback, night-sky/star background, neutral buttons, current radii/type/line heights and forced dark theme.

There is **no demonstrated reason to refactor functional JavaScript/TypeScript** for this styling work. Existing imperative code is inside React effects/event handlers, not a standalone vanilla-JS application:

| Existing code                                                                              | Why it stays                                                                                                            |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Shell Escape handler, toggle ref and delegated link click                                  | Drawer closing and focus restoration.                                                                                   |
| Form `requestAnimationFrame` + first-invalid query                                         | Accessible validation focus after rendering errors.                                                                     |
| `use-unsaved-changes.ts`: beforeunload, navigation API, delegated links and confirmation   | Existing unsaved-draft protection; preserve exact compatibility/fallback behavior.                                      |
| Sign-out unsaved-form query and location navigation; login FormData/location navigation    | Existing authentication/draft behavior, excluded from refactor.                                                         |
| Chat effects: matchMedia, scrollTop/scrollHeight, window scrolling, requestAnimationFrame  | Follow-only-when-pinned behavior, older-history offset preservation and desktop/mobile scroll split.                    |
| Chat abort/navigation listeners, session lifecycle and composer requestSubmit/IME handling | Streaming cancellation, draft continuity and duplicate prevention; do not edit.                                         |
| `getElementById("workspace-sidebar").classList.contains("is-open")`                        | Chat avoids auto-scrolling while mobile navigation is open. Keep that ID/class contract, even if visual classes change. |

No new hook, state layer, observer, third-party scroller, component split or DOM rewrite is justified. IDs, refs, semantic elements, aria attributes, data-unsaved and event handlers remain unchanged. JSX class edits are allowed only after stage approval.

## 5. Proposed stages and commit boundaries

### R1 — tokens and shared control styling

**Files:** `apps/web/src/index.css`; `packages/ui/src/styles/globals.css`; `packages/ui/src/components/{button,input,textarea,label}.tsx`. Leave action-link consumer edits to their R2/R3 owner stages; keep their legacy selector arms until then. They can reuse the existing exported `buttonVariants` without a new wrapper component or API layer.

**Changes:** expose the few Solyn token aliases needed for utilities; verify/correct existing source path; migrate shared control size/type/radius/colors/focus/invalid/disabled/hover/active appearance into existing primitives/CVA. Preserve app-specific control selectors until their counterpart is implemented. Retain explicit global field-outline exceptions if required by the global important focus policy. Keep note/chat geometry for later stages.

**Unchanged:** token values, Geist loading, forced dark theme, unused primitive modules/variant APIs, every input prop/label association and auth/action handler. No package/config framework changes.

**Risks:** utility-layer versus unlayered precedence, dark/responsive variant leftovers, `cn` merging, links differing from buttons, loss of invalid/focus feedback, changing ghost pressed state or context-specific textarea behavior.

**Verification/PM acceptance:** focused shared primitive static-render/class-merge tests where useful, existing workspace/chat tests, all normal checks. PM checks login/project/editor/chat control focus, invalid/disabled/hover/pressed states, no border/layout shift, 44px touch targets, keyboard outlines and unchanged typography at both sides of 768px.

**Commits:** (1) token aliases/source path only, (2) shared controls plus exact corresponding control-selector retirement, preserving the still-live action-link selector arms and their visual parity. Do not leave an intermediate commit with missing styles; shared primitive changes and their retiring overrides stay atomic.

### R2 — shell, workspace, lists, forms and editor

**Files:** `apps/web/src/components/{workspace-shell,sign-out-button}.tsx`; `features/workspace/{projects-screen,collection,project-form,note-editor,feedback,retry-panel}.tsx`; `app/(workspace)/projects/{new/page,[projectId]/page,[projectId]/edit/page,[projectId]/notes/new/page,[projectId]/notes/[noteId]/page}.tsx`; `app/(workspace)/{loading,error,not-found}.tsx`; `app/{error,not-found}.tsx`; `app/login/page.tsx` for styling only; `index.css`. Dashboard/projects route entry wrappers are inspected but need no change unless they actually own a migrated class. Test updates stay in existing frontend tests where practical.

**Selectors:** shell/navigation/recent/account, page/header, collection/empty/pagination, project summary, breadcrumbs, forms/help/errors, note/comparison/metadata and login/status/loading families in the table. Shared feedback/inline-action/link rules still used by chat cannot be deleted until chat callers are migrated (or updated class-only in the same commit).

**Changes:** replace simple declarations with literal utilities on existing owners. Preserve root global styling, small complex relationships and semantic/browser-code hooks where warranted. Keep DOM hierarchy and exact breakpoint values. Match full-width Project Form and left-aligned 760px Note Editor.

**Unchanged:** Server Components/actions/data fetching, owner checks, draft reducer, revision/no-op/conflict semantics, validation, route URLs, login/logout logic, loading/error behavior, drawer effects and accessibility hooks.

**Risks:** fixed/sticky containment, mobile flow, negative header margins, large project descriptions entering sticky chrome, long names, list time placement, note resizing/comparison states and shared CSS removal affecting chat/login.

**Verification/PM acceptance:** workspace frontend/state tests and full regression checks. PM checks dashboard/projects/detail/new/edit; long/empty/paginated lists; note new/edit/invalid/conflict/comparison; loading/error/not-found and login. Compare at 760px, 761px, 1100px and wide desktop; test coarse-pointer controls, drawer Escape/focus, skip link and unsaved navigation. Live write workflows remain PM-owned; do not create test records without approval.

**Commits:** (1) shell/navigation/recent history, (2) canvas headers/collections/project detail and status/loading/login presentation, (3) project forms and Note Editor/comparison. Each commit retires only owned CSS and preserves shared rules still consumed elsewhere.

### R3 — Ask Solyn presentation

**Files:** `features/chat/chat-screen.tsx`, `features/chat/message-content.tsx`, `index.css`, and focused additions to `features/chat/client.test.tsx` only if markup/class contracts need coverage. `components/workspace-shell.tsx` only if an already-existing chat canvas style requires a class change. No changes to route/action/service/transport/state files.

**Selectors:** chat screen/header/history/scope, thread/messages/roles, prose and composer/recovery/help families. Final shared feedback/inline-action/link migration may be completed here if R2 retained them.

**Changes:** utility-first layout on current elements; explicit literal role utility choices, not constructed utility fragments. Retain a small `.chat-prose` rule set if structural/code selectors would become less maintainable in JSX. Do not force existing Bubble/MessageScroller/InputGroup primitives into the screen.

**Unchanged:** full-width canvas padding, 760px individual prose cap, 75% desktop/92% mobile user bubbles, Solyn-left/user-right, all saved/pending/failed/stopped/provisional states, scroll refs/thresholds/effects, composer Enter/IME/Stop behavior and exact SSE protocol.

**Risks:** ancestor min-height/overflow affecting the actual scroll target, constrained code width, empty recovery bar taking space, composer focus returning to inner textarea, role/header misalignment and changed DOM breaking older-history scroll restoration.

**Verification/PM acceptance:** all client/transport/stream tests and full normal checks. PM checks short/long user messages, code/headings/lists, streaming follow and manual scroll-up, history menu, older-history loading, Stop, recovery and query navigation, mobile drawer/keyboard/safe areas and unchanged document scrolling. Do not use live inference or write tests as automated styling verification.

**Commits:** (1) chat header/history/thread/message presentation, (2) composer/recovery/help and associated remaining CSS. Keep prose with the first commit if it owns message appearance.

### R4 — evidence-based CSS retirement and regression

**Files:** primarily `index.css`; `packages/ui/src/styles/globals.css` only for a proven remaining duplicate; existing TSX owners only for obsolete class-token removal; existing frontend tests and this plan for final status. `docs/DESIGN.md` stays at 2.0 and does not need a redesign/update for implementation detail.

**Changes:** repeat full selector/consumer search, account for conditional/generated classes, remove migrated/dead selector arms and truly redundant declarations. Keep import/source/theme setup, global typography/resets still used, sky/star pseudo-element, selection, accessibility/reduced-motion and glass fallback rules; keep narrowly scoped scroll/focus/prose rules if clearer and safer. No CSS line-count target or zero-CSS mandate.

**Unchanged:** approved appearance, dependency graph, functional logic, unused shared primitive APIs, third-party CSS and Sonner variable bridge. Do not purge scaffold tokens or providers simply because direct feature calls are absent.

**Risks:** false-positive dead-code detection, deleting specificity glue before the final consumer migrates, duplicate semantics hidden behind responsive/pointer/support variants, visual regression undetected by unit tests.

**Verification/PM acceptance:** full `bun test`, types, oxlint, web build, changed-file oxfmt and diff checks; source review for no behavior edits; PM final desktop/mobile/keyboard/reduced-motion matrix covering all above screens. No automated browser/screenshots. Check branch diff contains no auth/backend/environment/schema/provider changes.

**Commit:** one focused obsolete-CSS cleanup plus final evidence; do not combine cleanup with a redesign or logic rewrite.

## 6. Acceptance, exclusions and PM decisions

**Required before R1:** PM approves this plan, including class-only login/status presentation as R2 parity work; no login handler/auth configuration changes. Each stage gets manual visual acceptance before expanding to the next. If exact parity requires a small existing CSS block, retain it rather than inventing an abstraction.

**Explicit exclusions:** streaming/persistence/client session state, CRUD/revisions/validation/navigation logic, authentication, provider/model/secrets, database/migrations/permissions, infrastructure, new packages, theme switching, rich text/Markdown engines, replacing native APIs, imported shared chat widgets, unused primitive removal, caching/query/performance work, browser automation and product/design changes.

**Evidence limitations:** existing frontend tests cover reducers, safe static markup and chat lifecycle/parser contracts, not computed CSS, mounted focus, mobile keyboard or actual browser scrolling. The current build establishes compilation, not visual parity. No performance bottleneck or need for functional JS refactoring was demonstrated. The explicit source-path issue needs installed Tailwind confirmation during R1. Data API disablement/deployment absence and prior visual/live-chat acceptance are PM confirmations, not fresh remote/browser probes.

**R0 change boundary:** only this audit/plan document is added. No CSS, component, JS/TS, configuration or DESIGN.md changes are implemented. Await PM approval before R1.
