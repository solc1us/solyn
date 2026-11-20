# Solyn — Product UI/UX Design System

**Version:** 2.0 · 18 November 2026  
**Status:** Implemented visual/interaction baseline; new changes and visual acceptance remain PM-owned
**Product:** Solyn — Personal AI Project Assistant  
**Applies to:** Existing workspace refinement (Phase 1), AI chat (Phase 2), and later knowledge workflows  
**References:** `docs/PRD.md` for product scope; current code, feature READMEs and `docs/NOTE_PROPOSALS.md` for implementation; `docs/TECH_DESIGN.md` is the historical Phase 1 design

> **North star:** A quiet project workspace with an AI assistant that understands context. Work stays in focus; AI is one step away.
>
> This document defines the **visual and interaction direction**. It does not authorize new features, database changes, authentication changes, or implementation of future phases.

## 1. Decisions at a glance

| Area                  | Design decision                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------- |
| Primary reference     | Linear: content-first hierarchy, calm navigation, consistent headers and low visual noise                     |
| Supporting references | ChatGPT Projects, Linear Agent, Claude Artifacts, Notion AI, Granola; Reflect for writing comfort             |
| Product identity      | **Calm Intelligence** — personal, deliberate, credible; not a generic AI SaaS dashboard                       |
| Theme                 | Dark charcoal workspace with subtle night-sky navy around it                                                  |
| Brand color           | Solyn Blue `#4F7CFF` for focus, active context and restrained emphasis; **not the default button fill**       |
| Buttons               | Compact neutral-elevated controls with a subtle top highlight; consistent medium radius, no pill-only styling |
| Density               | Compact productivity-app rhythm: tighter control, row and navigation padding without sacrificing usability    |
| Composition           | A persistent sidebar and **one dominant main canvas**; avoid nested full-size cards                           |
| Lists                 | Borderless rows; no per-item lines; soft neutral hover and selection backgrounds                              |
| AI                    | Implemented first-class **Ask Solyn** destination and project context entry points; note/source entry points remain phase-scoped         |
| Source interaction    | Open relevant notes from AI answers without losing chat context (in a future retrieval phase)                 |
| Writing               | Comfortable, plain-text-first note editor; existing explicit Save and conflict protection remain intact       |
| Content tone          | Short, direct, functional; no motivational filler, fake metrics, or decorative captions                       |
| Review ownership      | Agent verifies code; PM performs visual/UX acceptance manually                                                |

### Design boundaries

- **Keep:** existing starry background character, Solyn wordmark, blue accent, useful sidebar behavior, auth/ownership boundaries, and functional note editing.
- **Change:** navy-heavy content surfaces, floating collection-card composition, blue-filled default actions, generous component padding, oversized headings, unnecessary copy and row dividers.
- **Do not build prematurely:** AI panels, citations, source browser, chat history, document drafts, search, task views, or unused navigation before their actual phase.

## 2. Why these references

The references inform patterns, not visual cloning or feature parity.

| Product                 | Pattern adopted                                                                                                            | Not adopted                                                                             |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **Linear**              | Predictable sidebar and header structure; muted chrome; scan-friendly dense lists; understated hover, icons and separators | Issues, status groups, labels, team roles, or copied branded styling                    |
| **ChatGPT Projects**    | Conversations connected to a clearly identified project context; simple composer and thread continuity                     | Upload tools, subscriptions, extensive tool menus or unsupported memory behavior        |
| **Linear Agent**        | AI called from the work it already understands, rather than asking the user to re-enter context                            | Autonomous mutations or agent-specific workflow complexity                              |
| **Claude / Artifacts**  | When a substantial draft or source needs inspection, show a complementary panel beside chat                                | A permanent secondary pane or a full artifact framework                                 |
| **Notion AI / Granola** | Search/answers grounded in discoverable source content; linked original notes and decisions                                | External integrations, transcript capture, calendar automation or unsupported retrieval |
| **Reflect**             | Comfortable text width, modest controls, writing-first presentation                                                        | A rich-text or networked-note engine in Phase 1                                         |

Linear's March 2026 refresh explicitly reduces distracting sidebar prominence, unnecessary icon decoration and separators, while standardizing headers. Apply that principle across the entire Solyn application.

## 3. Visual identity and tokens

### 3.1 Color roles

The workspace should read as **dark neutral gray/charcoal**, not uniformly blue. The night sky is atmospheric framing, not the base color of every card.

| Token              | Proposed value            | Use                                                           |
| ------------------ | ------------------------- | ------------------------------------------------------------- |
| `--sky`            | `#080F20`                 | Outer background / subtle stars, **retain current mood**      |
| `--canvas`         | `#15171C`                 | Dominant main workspace surface                               |
| `--sidebar`        | `#171B23`                 | Sidebar / glass fallback, slightly quieter than canvas        |
| `--surface-raised` | `#20242B`                 | Menus, dialogs, floating previews when needed                 |
| `--button`         | `#272B31`                 | Default and primary action background (neutral)               |
| `--button-hover`   | `#333840`                 | Neutral button hover; no blue fill                            |
| `--button-border`  | `rgba(255,255,255,0.11)`  | Subtle button edge                                            |
| `--hover`          | `rgba(255,255,255,0.055)` | Borderless list-row hover                                     |
| `--selected`       | `rgba(255,255,255,0.095)` | Selected/active neutral state                                 |
| `--border`         | `rgba(255,255,255,0.085)` | Outer canvas edge, major header boundary only                 |
| `--text`           | `#F0F2F7`                 | Primary content                                               |
| `--text-secondary` | `#ABB2C0`                 | Descriptions and useful metadata                              |
| `--text-muted`     | `#939DAC`                 | Low-priority labels, check contrast in context                |
| `--accent`         | `#4F7CFF`                 | Brand dot, links, focused/active context and small highlights |
| `--focus`          | `#8CA9FF`                 | Visible keyboard focus                                        |

These are **design targets**, not a mandate to replace every existing token. Adjust through actual contrast tests and PM review. Do not apply blue to large panels, default buttons, lists or every icon. Use red/amber/green only for meaningful error/warning/success states; these are semantic colors, not competing brand accents. No important status should depend on color alone.

### 3.2 Buttons and control hierarchy

**Neutral is the default, including prominent creation actions.** The reference is a compact, dark elevated button with a slight light-catching top edge, not a bright filled CTA or an oversized pill.

- **Default action:** neutral `--button` surface, light text, thin `--button-border`, medium radius consistent with nearby controls. A subtle top-to-bottom tonal gradient or inset top highlight is allowed; it must remain nearly imperceptible. No thick shadow, halo, glass blur or glossy skeuomorphism.
- **Prominent action:** same neutral styling, differentiated by label weight, placement and optionally slightly stronger contrast; **New project**, **New note**, **Save** and **Send** do not need a full blue background.
- **Hover/pressed:** lighten the neutral surface on hover; pressed state becomes marginally darker. Transitions around 100–150ms, respecting reduced motion. No scale animation.
- **Secondary/quiet:** subtle surface or transparent ghost control; icon buttons share the same radius and interaction feedback.
- **Accent:** reserve Solyn Blue for brand punctuation, links, keyboard focus and restrained active/selected indicators. A solid blue CTA is an exceptional, separately reviewed use—not the default hierarchy.
- **Destructive/error:** semantic treatment only where the operation warrants it; do not camouflage destructive actions as ordinary neutral controls.
- **Disabled/pending:** clearly distinguish non-interactive state; never rely on color alone. All controls retain visible keyboard focus and accessible contrast.
- **Form field focus:** bordered inputs, textareas and date fields change only their existing border to the focus token (`--ring` in the implementation); no additional outline, ring, halo or focus shadow. Keep border thickness, radius and dimensions stable. Invalid fields retain their semantic error border and validation text. Intentionally borderless Note Editor title/content use a minimal focus-colored bottom border without adding a surrounding frame. Links, buttons, navigation and other interactive elements retain their visible keyboard focus indicators.

### 3.3 Compact spacing and radii

Use **dense but readable**, closer to a productivity tool than a marketing dashboard. These ranges are visual targets; existing component sizes and accessibility take precedence.

| Element                         | Desktop target                            | Notes                                                      |
| ------------------------------- | ----------------------------------------- | ---------------------------------------------------------- |
| Default buttons                 | ~30–34px tall; 10–12px horizontal padding | Icon-label gap ~6px; compact but easy to hit               |
| Icon buttons                    | ~32–36px square                           | Match button radius and highlight                          |
| Sidebar navigation item         | ~32–36px tall                             | Tighter vertical gaps; preserve active-state clarity       |
| One-line list row               | ~40–48px tall                             | No individual row border or box shadow                     |
| Row with supporting description | ~52–60px tall                             | Title-description gap ~2–4px                               |
| Canvas header                   | ~52–60px tall                             | Concise title/actions, one major divider permitted         |
| Canvas inner horizontal padding | ~16–24px                                  | Reduce further on mobile; align headers with rows          |
| Standard control/row radius     | ~6–8px                                    | Match the existing radius scale; do not force pill buttons |

- Tighten **internal** padding and gaps first; do not sacrifice the visually separate sidebar/canvas structure or writing readability.
- Avoid extra icon tiles behind every project row and unnecessary nested containers; these make compact layouts feel card-heavy.
- On touch screens, keep controls comfortably tappable (prefer roughly 44px targets or equivalent spacing); do not blindly apply compact desktop dimensions to mobile.
- The note writing column and chat prose retain comfortable breathing room even when navigation and actions are compact.

### 3.4 Background and glass

- Keep the existing deep navy sky, sparse low-opacity stars and minimal ambient glow. No animated particles, WebGL, videos or new decoration dependencies.
- The **main canvas** is opaque or nearly opaque charcoal so notes, chat and rows stay readable.
- The **sidebar** can retain restrained frosted glass (moderate blur, subtle edge). Dialogs/popovers may use the same treatment selectively.
- Avoid glass on note content, chat messages, text input areas, source excerpts and dense lists.
- Prefer a lighter neutral overlay on hover rather than glow, elevation, scale or bright blue fills.

### 3.5 Type and density

Use existing **Geist**. Define hierarchy by weight, spacing and alignment rather than oversized titles:

| Element                           | Preferred range                   |
| --------------------------------- | --------------------------------- |
| Compact canvas header             | 14–16px, medium/semibold          |
| Main heading within document view | 22–28px, semibold                 |
| Row primary text / chat body      | 14–16px                           |
| Row secondary text / metadata     | 12–13px, accessible contrast      |
| Note writing text                 | 16–18px, line height about 1.6    |
| Reading/chat message width        | Approximately 680–800px for prose |

Do not force a marketing hero into a productivity view. Constrain individual messages and note prose for readability, not the overall chat thread/composer or Project Form; those fill the canvas content width.

## 4. App shell and information architecture

### 4.1 Desktop composition

```text
┌────────────────┬────────────────────────────────────────────────────────────┐
│ solyn.         │ Context / title                        Primary action    │
│                ├────────────────────────────────────────────────────────────┤
│ Workspace      │                                                            │
│ Projects       │  Main content: a list, note, or conversation                │
│ Ask Solyn *    │                                                            │
│                │  Borderless rows OR a calm reading column                   │
│ [recent items] │                                                            │
│                │                                                            │
│ account        │                                                            │
└────────────────┴────────────────────────────────────────────────────────────┘
* Show Ask Solyn only once its chat functionality exists.
```

- Keep existing sidebar location and account/logout behavior. Reduce its brightness/visual weight if needed; do not redesign it from scratch.
- Put **the page header inside the same right-hand canvas** as the content. Keep it visible as a sticky header during desktop content scrolling; a single subtle header boundary is allowed. Long project descriptions and metadata belong in the scrolling content, not the persistent header.
- On desktop (above the existing 760px mobile breakpoint), keep the sidebar and main canvas stationary within the viewport. Preserve the canvas's 16px outer margins, sidebar gap and rounded corners; bound its height to the viewport instead of letting long content grow the document.
- Use the main canvas as the single workspace content scroll container across Workspace/Dashboard, Projects, Project Detail, create/edit forms and Note Editor, including loading/error states. Do not add a second page-level scroller or lock scrolling globally on login/mobile. Keep keyboard access to the scrollable canvas, visible focus and scroll clearance beneath its header; allow the existing sidebar and textareas to scroll when needed. When content is short, remaining canvas space stays empty and calm.
- Remove separate large `.surface` collection cards nested under a free-floating page heading. Avoid multiple layered borders and shadows.
- Use consistent header height, left inset and action placement across Projects, Project Detail, Note, and later Chat.
- Do not create a duplicate navigation hierarchy or decorative dashboard widgets just to fill space.

### 4.2 Navigation model

**Now (Phase 1):** Workspace, Projects, Project Detail, Note Editor.  
**When Phase 2 ships:** Add **Ask Solyn** as a visible primary sidebar destination, with recent conversations only if history is implemented.  
**Later:** Source citations and AI-proposed note drafts appear only with their actual feature implementations.

Transitions should preserve orientation:

- Breadcrumbs reflect the current project/note when relevant.
- Returning from a note to its project is obvious.
- Opening Ask Solyn from a project retains an **explicit project scope**. Opening it globally does not silently inherit an unrelated project.
- A chat opened from a linked source retains the conversation, scroll position and context when returning; prefer an on-demand preview on desktop when the feature exists.
- Before leaving an unsaved note, preserve current confirmation behavior. No navigation redesign may silently discard drafts.
- Never imply that switching an AI conversation's project changes the authorization scope without a new server-side check.

Avoid introducing custom tab-management infrastructure, cross-route state frameworks or hidden caches merely for seamlessness. Use existing Next.js route/state conventions and add persistent state only when real workflows require it.

### 4.3 Mobile

Maintain existing accessible mobile drawer. At the mobile breakpoint, preserve natural document scrolling: the canvas grows with content and page headers stay in normal flow beneath the existing mobile navigation. Do not carry over the desktop fixed canvas/internal scrolling constraint or introduce a scroll trap. The content canvas fills width with reduced margins; no permanent right preview. Header actions may collapse into a small menu. AI source/draft preview becomes a modal or separate screen with a clear **Back to chat** action. Preserve accessible focus, scrolling, and unsaved-change warnings.

## 5. Workspace, projects and note lists

### 5.1 Project list / home

- Compact `Projects` or `Workspace` header with **New project** on the right, inside canvas. The action uses the neutral-elevated button style, not blue fill.
- One header separator may distinguish navigation/header from content.
- **No table card, column-heading bar, or horizontal dividers between rows** for the basic project list.
- Each project is a single full-width, clickable row: compact folder icon (without a separate icon tile), name, optional one-line description, updated date on the right.
- Normal background transparent; hovered row receives `--hover`, 6–8px inner corner rounding, short 100–150ms transition; visible keyboard focus uses `--focus`.
- Use compact row padding and typography rather than borders; keep text and timestamps aligned without large empty insets. On narrow screens, put or hide date metadata appropriately without concealing the main title.
- Show a subtle `All projects` section label only when it aids orientation; do not add one merely to match Linear's issue-status grouping.
- Pagination/Load more remains functional and unobtrusive; no misleading total count if the backend only returns a page.
- Remove decorative footers, inspirational copy, redundant subtitles, fake activity, KPIs and placeholder data.

### 5.2 Project detail

Inside the **same canvas**: breadcrumb/project context → project title and compact edit/create actions → useful metadata → Notes heading → borderless note rows.

Each note row shows a title and relevant date. Differentiate historical `noteDate` from `updatedAt` when both are displayed. No artificial status tags or grouping. Empty state: one clear sentence and **New note**.

### 5.3 Create/edit forms

Use direct content areas within the canvas, not a floating form card inside another card. New and Edit Project share a full-width, left-aligned form with no centered maximum-width column. Align labels, helper text and actions to the canvas content padding; name and description fields fill the available width. This does not change the Note Editor's left-aligned 760px reading-width limit. Labels and validation stay accessible. Retain the actual Phase 1 domain contracts and all failure/loading behavior. No styling change may alter mutations, session checks, revalidation or note revision logic.

## 6. Note editor — writing-first

- Compact project breadcrumb and note header, with explicit **Save** as the main action using neutral-elevated styling.
- Title feels like a document heading rather than an input nested in multiple panels.
- Date and version metadata are secondary. A minimal major divider is acceptable to separate document chrome from writing area.
- Left-align both New and Edit Note content with the main canvas's content padding; do not horizontally center the editor. Let it fill available width up to a reasonable 760px maximum reading width, shrinking with the viewport. Keep title, date, plain-text content and save controls in this aligned column, preserving comfortable writing line height. Avoid persistent glowing borders or multiple frames.
- Keep exact whitespace, nullable historical note date, client validation, no-op save behavior, `expectedVersion`, conflict/reload comparison and unsaved-draft protection.
- No per-keystroke autosave. Never claim success before the backend confirms persistence.
- No rich-text engine, revision-history panel, or AI rewriting UI until separately scoped.

## 7. AI chat — first-class Solyn experience (future phase)

Chat is a **primary product workflow**, not a tiny floating chatbot. Treat it as a full content mode within the _same application shell_, while preserving access to projects and notes.

### 7.1 Chat view anatomy

```text
┌───────────────────────────────────────────────────────────────────────────┐
│ Ask Solyn                    General chat / Project: RESORA  New chat    │
├───────────────────────────────────────────────────────────────────────────┤
│                                                                           │
│  Solyn response                                   You / status           │
│  (readable prose width)                  [Neutral user message bubble]    │
│  Source links / draft actions when supported                              │
│                                                                           │
│                                                                           │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │ Message Solyn…                                                     │  │
│  │                                                              Send  │  │
│  └────────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────┘
```

**Persistent elements:** compact header, current scope, conversation, bottom composer. The overall thread and composer fill the main canvas content width, without a centered 760px column. Keep their content grid aligned with approximately 24px horizontal padding on desktop and 16px on mobile; constrain individual message widths for readability and scroll code blocks locally rather than overflowing the canvas. Avoid decorative avatars on every message, oversized AI gradients, large welcome heroes, tool icon clutter, and cards surrounding each answer.

**Phase 2D interaction clarification:** desktop chat keeps the existing stationary main canvas, with the message region as its independent scroller and the header/composer stationary. This is chat's exception to the normal canvas content scroller, not a second application layout. Mobile retains normal document scrolling and the navigation drawer, with a sticky bottom composer. History opens on demand as a bounded, keyboard-accessible menu; no permanent third column. Use `General chat` until retrieval exists. Project scope is a visible link back to its project, not a mutable selector; New chat is required to change scope. Create a conversation only on first submit, preserve exact turn IDs for ambiguous retries, and distinguish provisional output from saved history. PM performs manual visual/UX acceptance.

### 7.2 Composer

- Quiet, neutral composer anchored near the bottom; expands for multiline input. Its existing outer border changes to the focus token through `:focus-within`; the inner textarea adds no border, outline, ring or shadow. Preserve visible keyboard focus on Send/Stop buttons; no large glowing blue border.
- Visible send state; keyboard behavior chosen and documented consistently (e.g., Enter to send, Shift+Enter newline), with IME-safe submission.
- One primary affordance: **Send**, in the same neutral control hierarchy as the rest of the app. A focused composer may show a subtle blue focus indicator, not a blue-filled Send button. Add a Stop action during generation only when supported by the underlying implementation.
- Disabled/error states must be understandable; an unavailable LLM never appears as an empty or successful answer.
- No mic, image upload, model switcher, tools picker or attachment icon until each feature actually exists.

### 7.3 Message presentation

- User messages: right-align the entire block, including the `You` label and status. Use a restrained neutral bubble that fits short messages naturally; cap long messages at 75% of the thread and 760px on desktop, widening to 92% on mobile. Keep message text left-aligned, preserve whitespace and wrap long text; code blocks scroll within the bubble. No giant gradient bubbles.
- Solyn messages: remain left-aligned, with a readable maximum width of 760px and clean document-like text. Preserve sensible headings, lists, inline code/code blocks without a surrounding bubble or card per paragraph. Role alignment does not change saved, pending, failed, stopped or provisional states.
- Stream or progressively render only when the implementation supports it. Distinguish **generating**, **complete**, **failed**, and **stopped** states.
- Keep conversation position stable when new content arrives; do not yank the scroll if the user has scrolled up.
- Conversation history and thread titles appear only after persistence is implemented; opening another conversation should not silently lose unsent input.
- Responses should be concise by default and easy to scan, with the option to read detail through content hierarchy rather than filler text.

### 7.4 Context and scope — the key differentiator

Make the AI's _knowledge boundary_ visible:

- **Global chat:** labeled `All projects` only if cross-project retrieval is supported and authorized; otherwise label the actual available scope without implying more capability.
- **Project chat:** labeled `Project: [name]` and started from that project's detail via a clear **Ask Solyn** action.
- Switching scope must be intentional. Do not quietly attach other projects' data, mutate an existing conversation's access boundary, or present unsupported knowledge as retrieved.
- Server-side authorization and context selection are authoritative. The scope selector is not a security control by itself.
- Preserve scope for subsequent messages in a conversation, and make it easy to return to the originating project.

### 7.5 Sources, answers and confidence (retrieval phase)

When retrieval/citation functionality is available:

- Provide a short, descriptive **source link** near the relevant claim or in a concise `Sources` section, not a wall of references.
- Source links open the **original note**. On desktop, use a contextual preview if feasible; on mobile use a focused screen with **Back to chat**.
- Display source title, project and relevant date/excerpt where available, based on real persisted data.
- Distinguish what the source directly supports from AI inference. If evidence is insufficient, say so plainly.
- Never invent citations, source previews, project context or read capabilities.
- Do not make source opening save, rewrite or mutate the original note.

### 7.6 AI-assisted note draft (later phase)

Use a Claude-style **on-demand comparison/preview panel**, not a permanent third column:

`Chat → AI proposes draft → Review/edit → Confirm save → Open saved note`.

- Draft is visibly **unsaved** and editable before committing.
- Confirm and Cancel are explicit. AI must not overwrite original knowledge without the required server-enforced approval.
- On successful save, show a direct **Open note** link while preserving the chat context.
- Conflict, validation or save failure preserves the draft and never claims success.
- Reuse existing notes service/authorization model; this document does not authorize a new write API.

## 8. Seamless cross-module journeys

These are **target interactions** as features become available, not an order to implement them in Phase 1.

| Journey                             | Intended experience                                      | Guardrail                                                     |
| ----------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------- |
| Projects → Project → Note           | One shell, same header grammar, breadcrumb and back path | No duplicate data loading architecture solely for transitions |
| Project → Ask Solyn                 | Chat opens with a visible, authorized project context    | No hidden cross-project context                               |
| Ask Solyn → Source note → Chat      | Open original note; return to same thread and position   | No automatic note modification                                |
| Ask Solyn → Draft note → Saved note | Review and confirm before save; open resulting note      | Never auto-save AI output                                     |
| Global chat → Project chat          | Explicit scope choice or new conversation                | Do not silently reinterpret past messages                     |
| Note with unsaved edits → elsewhere | Warn before discarding                                   | Preserve existing draft safeguards                            |

**Rule:** seamless means fewer unnecessary steps **without hiding context, permissions, or writes**. Use clear destinations and retained orientation; do not assume every feature must be a single-page modal.

## 9. UI writing: remove filler

Prefer functional microcopy. Pages should not repeat the brand promise in every section.

| Avoid                                                                                     | Use                                               |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------- |
| “A place for the details you'll want to remember.”                                        | Remove                                            |
| “The context, decisions, and notes for everything you're working on.” beneath every title | Remove unless needed to explain the view          |
| “Give your notes a place to belong.”                                                      | `New project`                                     |
| “A discussion, a decision, a thought worth keeping.”                                      | `New note`                                        |
| “Original context, kept together”                                                         | Remove                                            |
| Long AI welcome paragraphs                                                                | `Ask about a project or your notes`               |
| “Working…” for every state                                                                | `Saving…`, `Loading…`, `Generating…` where useful |

Writing rules:

1. Header usually **one line**; description only if it resolves genuine ambiguity.
2. Empty states: what is missing + a single action; no motivational paragraph.
3. Buttons use clear verbs: **New project**, **New note**, **Save**, **Ask Solyn**, **Open note**, **Retry**.
4. Error copy explains what happened and the next safe action. Avoid exposing internals.
5. Metadata carries actual information (date, version, context), not decorative reassurance.
6. Default UI language currently follows the existing English app; do not introduce inconsistent mixed-language labels during visual refinement. Localization is a separate product decision.

## 10. Interaction, accessibility and performance

- WCAG 2.2 AA where applicable; test normal body-text contrast at least 4.5:1, nontext control contrast and focus visibility. Do not let hover be the only indicator of selection or focus.
- All interactive rows and compact controls support keyboard navigation and visible focus. Respect `prefers-reduced-motion`.
- On touch devices, hover effects are optional; spacing and target size must still make rows usable.
- Error, pending, empty, unauthenticated, not-found and conflict states retain existing functional paths. No fake loaders or fabricated note/project examples in production UI.
- Use existing components, Tailwind/CSS and Geist; avoid new frameworks/dependencies, decorative canvas engines, or excessive animations.
- Create/save latency is a **separate investigation**: measure server action, DB round-trip and route refresh before optimizing. This design change does not justify rewriting database operations.

## 11. Implementation boundaries and acceptance

### Phase 1 visual refinement — historical implementation scope

**Allowed:** Update `docs/DESIGN.md` and existing frontend layout/styles/components to implement unified charcoal canvas, neutral-elevated buttons, tighter component spacing, borderless hover rows, compact headers, reduced copy and preserved night sky/sidebar.  
**Not allowed:** Database/auth changes, backend refactor, AI placeholder UI, new dependencies, unrequested features or introducing an entirely new design system.

**PM acceptance:**

- Right side reads as one integrated app surface, not separate floating cards.
- Rows have no separators and become subtly lighter on hover; focus remains visible.
- Default/primary actions use compact neutral-elevated buttons with a restrained top highlight, rather than bright blue fills.
- Sidebar, rows, headers and controls use tighter, consistent spacing; touch and keyboard usability remain intact.
- Dark neutral canvas contrasts gently with night-sky perimeter.
- Sidebar stays recognizable but does not dominate content.
- Headings and utility text are compact; decorative copy removed.
- Project/note CRUD, revision conflict, unsaved-change and session behavior are unchanged.
- Agent runs focused tests/typecheck/lint/build; PM manually evaluates UI/UX.

### Phase 2 — chat (implemented)

Ask Solyn, conversation/history and Groq streaming are implemented in the workspace. Phase 3 adds confirmed AI-assisted note creation; source-grounded retrieval/citations and cross-project search are not implemented. Preserve the existing phase boundaries rather than treating this historical design as permission for additional features.

**Chat visual acceptance:** same app shell; compact neutral composer and Send control; visible scope; readable conversation; reliable loading/error behavior; logical return paths. Chat belongs to the product, not a decorative side-widget.

### Phase 3 drafts (implemented) and later retrieval

Durable editable note previews, explicit confirmation and verified saved-note links are implemented and merged. Retrieval, citations and a source browser remain later scope. Preserve user confirmation and backend enforcement; merge status does not substitute for live integration or PM visual verification.

## 12. Research references

Official references reviewed 18 November 2026; these inform design patterns, not Solyn's feature commitments.

- Linear, **A calmer interface for a product in motion** (12 Mar 2026): https://linear.app/now/behind-the-latest-design-refresh
- Linear, **UI refresh** (12 Mar 2026): https://linear.app/changelog/2026-03-12-ui-refresh
- Linear, **Documents**: https://linear.app/docs/documents
- Linear, **Linear Agent**: https://linear.app/docs/linear-agent
- OpenAI, **Projects in ChatGPT**: https://help.openai.com/en/articles/10169521-projects-in-chatgpt
- Anthropic, **What are artifacts and how do I use them?**: https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them
- Anthropic, **Create and manage projects**: https://support.claude.com/en/articles/9519177-how-can-i-create-and-manage-projects
- Notion, **Search for pages & content**: https://www.notion.com/help/search
- Granola, **Chat**: https://www.granola.ai/chat
- Granola, **Meeting notes and citations**: https://www.granola.ai/blog/how-to-use-ai-to-take-meeting-notes-a-step-by-step-guide-for-2026
- Reflect: https://reflect.app/
- W3C, **WCAG 2.2**: https://www.w3.org/TR/WCAG22/

---

**Final design test:** If an element does not support orientation, input, understanding, trust, or a real action, it probably does not need to appear.
