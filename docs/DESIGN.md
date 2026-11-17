# Solyn — UI/UX Design Brief

**Version:** 1.0  
**Status:** Approved design direction, pending implementation  
**Product:** Solyn — Personal AI Project Assistant  
**Initial implementation:** Phase 1E — Core Workspace Frontend

---

## 1. Design Vision

Solyn is a personal AI project assistant that helps users organize project knowledge, preserve important notes, and eventually understand and manage their work through AI.

The interface should feel like a quiet, intelligent workspace where users can think clearly and work comfortably.

**Design philosophy: Calm Intelligence.**

Solyn combines the functional clarity of a modern productivity application with the subtle atmosphere of a night sky.

### Desired characteristics

- **Calm:** Minimal visual noise and unnecessary decoration.
- **Intelligent:** Clear information hierarchy and contextual interactions.
- **Personal:** Welcoming and focused, not corporate or enterprise-heavy.
- **Premium:** Refined details, consistent spacing, and restrained effects.
- **Efficient:** Quick access to projects, notes, and important actions.
- **Scalable:** Supports future AI, tasks, and deadlines without redesigning the entire navigation.

**Guiding principle:** The atmosphere enhances the workspace; it must never compete with the content.

---

## 2. Design References

### Primary reference: Linear

Website: https://linear.app

Use Linear as inspiration for:

- Application layout and information hierarchy.
- Persistent desktop sidebar navigation.
- Compact, consistent controls.
- Clear typography and restrained visual elements.
- Predictable interactions.
- Keyboard-friendly productivity workflows.
- Contextual menus and progressive disclosure.

Do not copy Linear's branding, exact layout, or distinctive visual assets.

### Secondary reference: Reflect

Website: https://reflect.app

Use Reflect as inspiration for:

- Comfortable note reading and writing.
- Focused editing experience.
- Clean text presentation.
- Minimal distractions around content.

### Additional reference: Granola

Website: https://www.granola.ai

Use Granola as inspiration for:

- Meeting notes presentation.
- Clear separation of content and metadata.
- A personal, approachable productivity experience.

### Future reference: Capacities

Website: https://capacities.io

Use Capacities only as conceptual inspiration for future contextual AI interactions.

Do not implement AI panels or chat interfaces in Phase 1E.

---

## 3. Brand Identity

### Brand name

**Solyn**

Preferred wordmark: **solyn.**

The wordmark should use clean, modern typography, with the final dot highlighted using the primary blue accent.

A separate symbol or illustration is not required for Phase 1E.

### Brand personality

- Thoughtful
- Reliable
- Calm
- Modern
- Focused
- Approachable

### Visual atmosphere

A quiet workspace floating over a subtle star-filled night sky.

Avoid a cyberpunk, gaming, neon, or overly futuristic aesthetic.

### Brand expression

**Solyn — Clarity for everything you're working on.**

This tagline communicates the desired identity but does not need to appear throughout the application.

---

## 4. Color System

### Primary accent

**Solyn Blue — `#4F7CFF`**

Use this blue as the primary brand accent.

| Token         | Color     | Purpose                                   |
| ------------- | --------- | ----------------------------------------- |
| Primary       | `#4F7CFF` | Brand accent and primary actions          |
| Primary Hover | `#3F6EF5` | Interactive hover states                  |
| Primary Soft  | `#182A54` | Selected navigation and subtle highlights |
| Focus Ring    | `#88A7FF` | Keyboard focus indication                 |

Primary buttons must use foreground text with sufficient contrast. Prefer a dark foreground on the primary blue rather than assuming white text is accessible.

### Dark theme palette

| Token               | Color                       | Purpose                      |
| ------------------- | --------------------------- | ---------------------------- |
| Night Background    | `#080F20`                   | Main application atmosphere  |
| Background Elevated | `#101A30`                   | Secondary dark background    |
| Content Surface     | `#131E33`                   | Reading and editing surfaces |
| Glass Base          | `rgba(16, 26, 47, 0.76)`    | Frosted panels               |
| Border              | `rgba(175, 197, 255, 0.14)` | Subtle separators            |
| Text Primary        | `#EFF4FF`                   | Main content                 |
| Text Secondary      | `#A8B5D0`                   | Supporting descriptions      |
| Text Muted          | `#7786A5`                   | Low-priority metadata        |

These values establish the desired visual direction. Verify contrast in the actual interface and adjust where necessary.

### Color rules

- Blue communicates primary actions, selection, and active focus.
- Neutral colors dominate the interface.
- Avoid excessive accent colors.
- Semantic feedback colors may be used for success, warning, and error states.
- Never communicate status using color alone.

---

## 5. Night Sky Background

The application uses a subtle night sky as its primary atmospheric background.

### Appearance

- Deep navy to near-black gradient.
- Sparse, small, low-contrast stars.
- Very subtle blue ambient glow.
- No prominent constellations or large decorative objects.
- No distracting movement behind workspace content.

The background should remain visible mainly around workspace panels and in low-content areas.

### Technical approach

Prefer lightweight CSS-based gradients and static decorative elements.

Avoid:

- Heavy canvas rendering.
- WebGL or Three.js.
- Particle animation libraries.
- Large background videos.
- Continuous moving stars.
- Dependencies introduced solely for decorative effects.

Use a fixed, non-interactive decorative layer that does not capture pointer events.

Respect `prefers-reduced-motion`.

The background must not reduce text readability or cause noticeable scrolling/rendering performance problems.

---

## 6. Frosted Glass Design

Use **selective frosted glass**, not glassmorphism everywhere.

### Appropriate uses

- Main navigation sidebar.
- Top navigation or floating toolbar where present.
- Modal/dialog surfaces.
- Dropdowns and contextual overlays.
- Lightweight supporting panels.

### Avoid excessive glass on

- Long-form note editor.
- Dense note lists.
- Important forms.
- Content-heavy reading areas.

### Glass characteristics

- Dark translucent surface.
- Moderate backdrop blur, approximately 12–20px.
- Thin, low-contrast border.
- Soft shadow for visual separation.
- Minimal glow.
- Clear distinction between foreground and background.

Provide a sufficiently opaque fallback when backdrop blur is unavailable.

**Important:** Text contrast and usability always take priority over transparency.

---

## 7. Typography

Use the existing **Geist** typography included in the project.

Do not add another font dependency without a clear need.

### Typography hierarchy

| Element           | Direction                    |
| ----------------- | ---------------------------- |
| Page heading      | 24–28px, semibold            |
| Section heading   | 18–20px, semibold            |
| Primary body      | 14–16px                      |
| Note editor       | 16–18px, relaxed line height |
| Metadata          | 12–14px                      |
| Navigation labels | 13–14px                      |

### Reading experience

- Comfortable line height, approximately 1.6–1.75 for notes.
- Keep long-form reading width around 680–800px.
- Maintain consistent hierarchy and spacing.
- Avoid excessive bold text.
- Do not use uppercase headings everywhere.
- Use muted text only for supporting information, never critical content.

The note editor must feel closer to a focused writing application than a conventional administrative form.

---

## 8. Application Layout

### Desktop structure

A persistent left sidebar with a flexible main workspace.

**Sidebar**

- Solyn wordmark.
- Home / Workspace navigation.
- Projects navigation.
- List of accessible projects when useful.
- Account and logout controls.

**Main workspace**

- Contextual page title.
- Breadcrumbs where helpful.
- Primary action near the relevant heading.
- Content list, detail, or editor.
- Clear loading, empty, and error states.

### Layout guidelines

- Sidebar target width: approximately 240–264px.
- Main content should use available space without excessive stretching.
- Consistent spacing and alignment.
- Avoid unnecessary nested cards.
- Use subtle dividers instead of heavy borders.
- Maintain a clear hierarchy between navigation, metadata, and content.

### Responsive behavior

On smaller screens:

- Replace persistent sidebar with a drawer or compact navigation.
- Keep project and note actions accessible.
- Preserve comfortable text size and touch targets.
- Avoid horizontal scrolling in the main workspace.
- Prioritize the editor and content over decoration.

---

## 9. Phase 1E — Required Screens

Only implement the screens needed for the manual Project & Notes Workspace.

### 9.1 Login

Purpose: Authenticate the existing owner.

Requirements:

- Custom Solyn appearance.
- Email and password fields.
- Clear submit, pending, and error states.
- Accessible form labels.
- No public sign-up entry point.
- No unnecessary onboarding illustrations.

Keep Better Auth integration intact.

### 9.2 Home / Dashboard

Purpose: Provide a clear entry point to the user's work.

Include:

- Welcoming page heading.
- User's projects.
- Primary action to create a project.
- Useful empty state when no projects exist.

Avoid unnecessary analytics and productivity metrics.

Do not add artificial activity feeds, fake AI insights, or task widgets.

### 9.3 Project Detail

Purpose: View and manage a specific project.

Include:

- Project name and description.
- Edit project metadata.
- Notes associated with that project.
- Primary action to create a note.
- Dates or timestamps where relevant.
- Clear empty state when no notes exist.

Notes should be easy to scan and navigate.

### 9.4 Note Detail / Editor

Purpose: Read and edit project knowledge comfortably.

Include:

- Project context or breadcrumb.
- Editable note title.
- Note content.
- Optional note date.
- Created/last-updated metadata where useful.
- Explicit Save action.
- Save pending, success, and failure feedback.

Use a focused, readable editor layout.

For Phase 1E, a plain-text editor with comfortable styling is sufficient. Do not introduce a rich-text framework merely for visual polish.

Important behaviors:

- Do not save automatically on every keystroke.
- Avoid generating unnecessary note revisions.
- Do not claim a save succeeded before the backend confirms it.
- Warn users about unsaved changes when leaving an editor, where feasible.
- Keep historical note dates distinct from creation timestamps.

A full revision history UI is not required in Phase 1E.

---

## 10. Interaction Design

### Primary actions

Each major screen should have one obvious primary action.

Examples:

- Dashboard → New Project
- Project Detail → New Note
- Note Editor → Save Changes

Avoid multiple competing primary buttons.

### Feedback and states

Every asynchronous action must handle:

- Loading/pending.
- Success.
- Failure.
- Empty results.
- Validation errors.

Use concise, informative messages.

Avoid excessive toast notifications for routine interactions.

### Navigation

- Keep users aware of the current project.
- Provide predictable back navigation.
- Do not unexpectedly reset editor state.
- Maintain clear active navigation indicators.
- Use semantic, accessible controls.

### Forms

- Inline validation for incorrect input.
- Helpful error messages.
- Visible
